// @ts-check
// init: set the vault and write the one-line rule. The only command that registers a vault.
import fs from 'node:fs';
import path from 'node:path';
import { homeDir, loadConfig, saveConfig, indexDirFor, VAULT_DEFAULTS } from '../../config/config.js';
import { checkOneVault, checkIndexOutside, inCloudFolder, CLOUD_VAULT_NOTE, CLOUD_HOME_NOTE } from '../../config/guards.js';
import { resolveSafe, isInside, vaultRootAbove, tildify, expandHome } from '../../config/paths.js';
import { configureWriter, writeFile } from '../../store/safe-write.js';
import { walkVault, excludePath } from '../../vault/walk.js';
import { lookupVault } from '../../vault/obsidian-registry.js';
import { stat, walk } from '../../vault/read-only-fs.js';
import { RULE_BLOCK, RULE_START, RULE_END } from '../../rule-text.js';
import { VmError } from '../../errors.js';
import { plural } from '../output.js';

/** The vault's templates folder, when Obsidian's templates plugin names one. @param {string} vaultReal */
function templatesFolder(vaultReal) {
  try {
    const folder = JSON.parse(fs.readFileSync(path.join(vaultReal, '.obsidian', 'templates.json'), 'utf8')).folder;
    if (typeof folder !== 'string' || !folder.trim()) return null;
    const named = folder.replace(/^\/+|\/+$/g, '');
    if (stat(path.join(vaultReal, named))?.isDir) return named;
    // On a disk that tells letter case apart, look for the folder the way the walk leaves it out: without regard to case.
    let dir = vaultReal;
    for (const seg of named.split('/')) {
      const hit = walk(dir).find((e) => e.isDir && e.name.toLowerCase() === seg.toLowerCase());
      if (!hit) return null;
      dir = hit.abs;
    }
    return named;
  } catch { /* no templates plugin settings */ }
  return null;
}

/** May the rule be written into this project folder? @param {string} project @param {string} vaultReal @param {string[]} obsidianVaults */
export function projectCheck(project, vaultReal, obsidianVaults) {
  let real;
  try { real = resolveSafe(project); } catch { return { ok: false, reason: 'the folder could not be resolved' }; }
  if (!stat(real)?.isDir) return { ok: false, reason: 'the folder does not exist' };
  if (isInside(real, vaultReal)) return { ok: false, reason: 'it is inside your vault' };
  if (vaultRootAbove(real)) return { ok: false, reason: 'it is inside a vault' };
  for (const v of obsidianVaults) { try { if (v && isInside(real, resolveSafe(v))) return { ok: false, reason: 'it is inside a vault Obsidian knows' }; } catch { /* unreadable entry */ } }
  return { ok: true, reason: null, real };
}

/**
 * Insert or replace the rule between its two markers. Nothing else in the file is touched.
 * A file whose every line ends the Windows way (CRLF) gets the rule in that form, so it never ends up with both.
 * @param {string | null} existing
 */
export function applyRule(existing) {
  if (existing == null) return { text: RULE_BLOCK + '\n', action: 'created' };
  const eol = existing.includes('\r\n') && !/(^|[^\r])\n/.test(existing) ? '\r\n' : '\n';
  const block = RULE_BLOCK.split('\n').join(eol);
  const a = existing.indexOf(RULE_START); const b = existing.indexOf(RULE_END);
  if (a >= 0 && b > a) {
    const next = existing.slice(0, a) + block + existing.slice(b + RULE_END.length);
    return { text: next, action: next === existing ? 'unchanged' : 'updated' };
  }
  const sep = existing.length === 0 || existing.endsWith(eol + eol) ? '' : existing.endsWith('\n') ? eol : eol + eol;
  return { text: existing + sep + block + eol, action: 'updated' };
}

/**
 * @param {{ vaultPath: string, project?: string, noRule?: boolean, exclude?: string[] }} args
 * @param {import('../output.js').Ui} ui
 */
export async function initCommand(args, ui) {
  const home = homeDir();
  const one = checkOneVault(expandHome(args.vaultPath));
  checkIndexOutside(one.real, home);
  const registry = lookupVault(one.real);
  const project = path.resolve(args.project || process.cwd());
  const check = args.noRule ? { ok: false, reason: 'you asked for no rule file' } : projectCheck(project, one.real, registry.vaults);
  const ruleTargets = check.ok ? [path.join(project, 'CLAUDE.md'), path.join(project, 'AGENTS.md')] : [];
  configureWriter({ home, vault: one.real, ruleFiles: ruleTargets });

  const previous = loadConfig(home);
  const same = previous.vault && (() => { try { return resolveSafe(previous.vault.path) === one.real; } catch { return false; } })();
  // What was asked for now, as a path inside the vault: "./Private", "Private/" and the folder's full path all mean "Private".
  /** @type {{ asked: string, entry: string }[]} */
  const asked = [];
  for (const e of args.exclude || []) {
    let full = /^~[\\/]/.test(e) ? expandHome(e) : e;
    if (path.isAbsolute(full)) { try { full = resolveSafe(full); } catch { /* compared as written */ } }
    const entry = excludePath(one.real, full);
    if (!entry) throw new VmError('VM_E_USAGE', { detail: `--exclude "${e}" does not name a folder inside ${tildify(one.real)}, so nothing would be left out. Give the folder's name as it appears inside the vault, for example --exclude "Private". Nothing was changed.` });
    asked.push({ asked: e, entry });
  }
  const sameKey = (/** @type {string} */ a, /** @type {string} */ b) => excludePath(one.real, a).toLowerCase() === excludePath(one.real, b).toLowerCase();
  /** @type {string[]} */
  const exclude = [...new Set(same && previous.vault ? previous.vault.exclude : [])];
  for (const a of asked) if (!exclude.some((x) => sameKey(x, a.entry))) exclude.push(a.entry);
  const templates = templatesFolder(one.real);
  let proposed = null;
  if (templates && !exclude.some((x) => sameKey(x, templates))) { exclude.push(templates); proposed = templates; }
  const walk = walkVault(one.real, { exclude, obsidianExcludes: true });
  const notesFound = walk.notes.length;
  if (notesFound + walk.leftOut.length === 0) throw new VmError('VM_E_USAGE', { detail: `No notes (.md files) were found in ${tildify(one.real)}.` });
  // A folder asked for by name that is not there is refused: saying yes would index notes the person wanted left out.
  const missed = asked.find((a) => walk.unmatchedExcludes.includes(a.entry));
  if (missed) throw new VmError('VM_E_USAGE', { detail: `--exclude "${missed.asked}": this vault has no folder or note with that name, so nothing would be left out. Check the spelling and give the folder's name as it appears inside the vault. Nothing was changed.` });

  const vault = { ...VAULT_DEFAULTS, ...(same && previous.vault ? previous.vault : {}), path: one.real, exclude };
  saveConfig(home, { ...previous, vault });
  const indexDir = indexDirFor(home, one.real);
  const name = path.basename(one.real);

  /** @type {{ file: string, action: string, reason: string | null }[]} */
  const ruleFiles = [];
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    const target = path.join(project, file);
    if (!check.ok) { ruleFiles.push({ file: target, action: 'skipped', reason: check.reason }); continue; }
    let existing = null;
    try { existing = fs.readFileSync(target, 'utf8'); } catch { existing = null; }
    const r = applyRule(existing);
    if (r.action !== 'unchanged') writeFile(target, r.text);
    ruleFiles.push({ file: target, action: r.action, reason: null });
  }

  if (previous.vault && !same) ui.info(`Switched from ${tildify(previous.vault.path)} to ${tildify(one.real)}. Each vault keeps its own index, so switching back costs nothing.`);
  ui.out(`Set up ${name} (${plural(notesFound, 'note')}). It only reads your notes. The index lives in ${tildify(indexDir)}, outside the vault, and holds a copy of your notes' text on this computer only.`);
  if (proposed) ui.out(`Left out the templates folder "${proposed}". To include it, remove it from "exclude" in ${tildify(path.join(home, 'config.json'))}.`);
  for (const w of [...one.warnings, ...walk.warnings]) ui.warn(w);
  if (inCloudFolder(one.real)) ui.warn(CLOUD_VAULT_NOTE);
  try { if (inCloudFolder(resolveSafe(home))) ui.warn(CLOUD_HOME_NOTE); } catch { /* checked by the guards */ }
  if (check.ok) ui.out(`Wrote the vault rule to CLAUDE.md and AGENTS.md in ${tildify(project)}. (Wrong folder? Run init again with --project <folder>.)`);
  else if (!args.noRule) {
    ui.out(`The vault rule was not written to ${tildify(project)} because ${check.reason}. Paste this into your project's CLAUDE.md or AGENTS.md:`);
    ui.out(RULE_BLOCK);
  }
  ui.out('Next: vault-mirror sync');
  return { vault: { name, path: one.real }, body: { indexDir, notesFound, excluded: exclude, ruleFiles } };
}
