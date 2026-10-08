#!/usr/bin/env node
// The first ten minutes of a new user, on whatever system this runs on: the installed tool against a
// small invented vault. Its path has spaces and parentheses and sits in a folder named the way OneDrive
// names one; its notes have spaces, non-English letters and an emoji in their names. Then the things a
// first week brings: a note renamed in letter case only, a note at a very long path, a note another
// program holds, and a full rebuild. It prints the real output of every command, with timings, and
// compares a checksum listing of the vault after every command.
//
//   node tests/acceptance/first-run.mjs [--installed | --bin <path to a bin/vault-mirror.js>] [--default-home]
//
// With no option it runs this checkout. --installed runs the copy that `npm install -g` put on this
// computer (CI uses this). The index goes to a temp folder unless --default-home is given.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { values: opt } = parseArgs({ options: { bin: { type: 'string' }, installed: { type: 'boolean' }, 'default-home': { type: 'boolean' }, keep: { type: 'boolean' } } });
const globalRoot = () => spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).stdout.trim();
const BIN = opt.installed ? path.join(globalRoot(), 'vault-mirror', 'bin', 'vault-mirror.js') : opt.bin ? path.resolve(opt.bin) : path.join(HERE, '..', '..', 'bin', 'vault-mirror.js');
if (!fs.existsSync(BIN)) { console.error(`No vault-mirror at ${BIN}`); process.exit(2); }

const tmpBase = process.env.VAULT_MIRROR_TEST_TMP || os.tmpdir();
fs.mkdirSync(tmpBase, { recursive: true });
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpBase, 'vm first run ')));
const VAULT = path.join(base, 'OneDrive - Contoso', 'My Vault (work)');
const PROJECT = path.join(base, 'my project (notes)');
const CRLF_PROJECT = path.join(base, 'a project with Windows line endings');
const OBS_JSON = path.join(base, 'obsidian.json');
const HOME = opt['default-home'] ? null : path.join(base, 'index home');

const NOTES = {
  'Garden plan.md': '# Garden plan\n\nMove the tomato seedlings outside after the last frost, usually in the second week of May.\n\n## Watering\n\nWater the raised beds early in the morning, twice a week in a dry spell.\n',
  'Café Zürich notes.md': '# Café Zürich notes\n\nThe café on Bahnhofstraße opens at seven. Order the Birchermüesli and ask for the window table.\n',
  'Recetas/Año nuevo señor Peña.md': '# Año nuevo\n\nLa receta de la abuela: lentejas con chorizo para el almuerzo del primer día del año.\n',
  '日本語/庭の手入れ.md': '# 庭の手入れ\n\nIn spring, prune the roses (バラの剪定) and mix compost into the soil. 春になったら、堆肥を土に混ぜる。\n',
  // A name as a Mac makes it: each accent is a plain letter followed by a separate mark.
  'Mac names/Cre\u0301me bru\u0302le\u0301e.md': '# Custard\n\nThe invented ferry cook torches the sugar with a brass blowlamp kept beside the anchor locker.\n',
  'Seeds \u{1F331}/Tomato \u{1F345} log.md': '# Tomato log\n\nThe invented signalman sows the beefsteak tomatoes in a zinc bathtub behind the level crossing.\n',
  'Work/Meeting notes 2031-03-04.md': '---\ntags: [work]\n---\n# Meeting notes\n\nThe invented harbour committee agreed to repaint the north pier lighthouse in June.\r\n\r\nA line with Windows line endings.\r\n',
};
fs.mkdirSync(path.join(VAULT, '.obsidian'), { recursive: true });
fs.mkdirSync(PROJECT);
fs.mkdirSync(CRLF_PROJECT);
const CRLF_BEFORE = '# My project\r\n\r\nKeep this line.\r\n';
fs.writeFileSync(path.join(CRLF_PROJECT, 'CLAUDE.md'), CRLF_BEFORE);
for (const [rel, text] of Object.entries(NOTES)) { const p = path.join(VAULT, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
fs.writeFileSync(OBS_JSON, JSON.stringify({ vaults: { a1b2c3d4e5f60718: { path: VAULT, ts: 1, open: true } } }));

/** Every file of the vault: path -> size and SHA-256. */
function snapshot() {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) { out.push(`${path.relative(VAULT, abs)}${path.sep}`); walk(abs); }
      else { const s = fs.statSync(abs, { bigint: true }); out.push(`${path.relative(VAULT, abs)} ${s.size} ${s.mtimeNs} ${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`); }
    }
  };
  walk(VAULT);
  return out.join('\n');
}
let expected = snapshot();
let checks = 0;
/** @type {{ name: string, ok: boolean, detail: string }[]} */
const results = [];
/** @type {Record<string, number>} */
const timings = {};

/** Run the tool, print what it printed, and check the vault. */
function vm(/** @type {string[]} */ args, /** @type {string} */ label = args[0]) {
  const env = { ...process.env, NO_COLOR: '1', VAULT_MIRROR_OBSIDIAN_JSON: OBS_JSON, ...(HOME ? { VAULT_MIRROR_HOME: HOME } : {}) };
  const t = Date.now();
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: PROJECT, env, encoding: 'utf8', timeout: 900000 });
  const ms = Date.now() - t;
  timings[label] = ms;
  console.log(`\n$ vault-mirror ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}    [exit ${r.status}, ${ms} ms]`);
  if (r.stdout.trim()) console.log(r.stdout.trimEnd().split('\n').map((l) => `  ${l}`).join('\n'));
  if (r.stderr.trim()) console.log(r.stderr.trimEnd().split('\n').map((l) => `  (stderr) ${l}`).join('\n'));
  checks++;
  if (snapshot() !== expected) throw new Error(`THE VAULT CHANGED after vault-mirror ${args[0]}`);
  /** @type {any} */
  let json = null;
  if (args.includes('--json')) { try { json = JSON.parse(r.stdout); } catch { json = null; } }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, ms };
}
function step(/** @type {string} */ name, /** @type {() => string | void} */ fn) {
  try { const detail = fn() || ''; results.push({ name, ok: true, detail }); console.log(`PASS  ${name}${detail ? `  [${detail}]` : ''}`); }
  catch (e) { const detail = String(/** @type {any} */ (e).message); results.push({ name, ok: false, detail }); console.log(`FAIL  ${name}\n      ${detail}`); }
}
const must = (/** @type {any} */ cond, /** @type {string} */ message) => { if (!cond) throw new Error(message); };

console.log(`vault-mirror first-run test\n  system: ${process.platform} ${process.arch}, node ${process.version}, ${os.cpus().length} cores, ${(os.totalmem() / 2 ** 30).toFixed(0)} GB\n  tool:   ${BIN}\n  vault:  ${VAULT}\n  index:  ${HOME || '(the default home folder)'}`);

step('version', () => { const r = vm(['--version']); must(r.status === 0, `exit ${r.status}`); return r.stdout.trim(); });

step('doctor before anything', () => {
  const r = vm(['doctor', '--json'], 'doctor');
  vm(['doctor'], 'doctor (as a person sees it)');
  must(r.json, 'doctor printed no JSON');
  const failed = r.json.checks.filter((/** @type {any} */ c) => c.status === 'fail').map((/** @type {any} */ c) => `${c.name}: ${c.message || c.text || ''}`);
  must(failed.length === 0 && r.status === 0, `exit ${r.status}; failed checks: ${failed.join(' | ') || 'none'}`);
  return `${r.json.checks.length} checks, none failed`;
});

let INDEX_DIR = '';
step('init on a vault whose path has spaces and parentheses, in a OneDrive-style folder', () => {
  const r = vm(['init', VAULT, '--project', PROJECT, '--json'], 'init');
  must(r.status === 0, `exit ${r.status}: ${r.stdout.slice(0, 300)}`);
  must(r.json.vault.path === VAULT, `the vault path came back as ${r.json.vault.path}, wanted ${VAULT}`);
  must(r.json.notesFound === Object.keys(NOTES).length, `found ${r.json.notesFound} notes, wanted ${Object.keys(NOTES).length}`);
  must(r.json.warnings.some((/** @type {string} */ w) => /may sync to the cloud/.test(w)), `no word about the cloud folder: ${JSON.stringify(r.json.warnings)}`);
  must(fs.readdirSync(PROJECT).sort().join(',') === 'AGENTS.md,CLAUDE.md', `rule files in the project folder: ${fs.readdirSync(PROJECT).join(',')}`);
  must(!fs.readFileSync(path.join(PROJECT, 'CLAUDE.md'), 'utf8').includes('\r'), 'the rule file has Windows line endings');
  // Where the index lives: under the home folder, outside the vault, and it exists once a sync has run.
  INDEX_DIR = r.json.indexDir;
  const root = HOME || path.join(os.homedir(), '.vault-mirror');
  must(path.isAbsolute(INDEX_DIR) && INDEX_DIR.startsWith(path.join(root, 'indexes') + path.sep), `the index folder ${INDEX_DIR} is not under ${root}`);
  must(!INDEX_DIR.startsWith(VAULT + path.sep) && !VAULT.startsWith(INDEX_DIR + path.sep), 'the index folder and the vault hold one another');
  return `${r.json.notesFound} notes found; the index folder is ${r.json.indexDir}`;
});

step('the rule: one copy after a second init, and a file with Windows line endings keeps them', () => {
  const count = (/** @type {string} */ file) => fs.readFileSync(file, 'utf8').split('vault-mirror:start').length - 1;
  const before = fs.readFileSync(path.join(PROJECT, 'CLAUDE.md'), 'utf8');
  const again = vm(['init', VAULT, '--project', PROJECT, '--json'], 'init again');
  must(again.status === 0 && again.json.ruleFiles.every((/** @type {any} */ x) => x.action === 'unchanged'), `a second init: ${JSON.stringify(again.json && again.json.ruleFiles)}`);
  must(fs.readFileSync(path.join(PROJECT, 'CLAUDE.md'), 'utf8') === before && count(path.join(PROJECT, 'CLAUDE.md')) === 1 && count(path.join(PROJECT, 'AGENTS.md')) === 1, 'the rule is there more than once, or the file changed');
  const r = vm(['init', VAULT, '--project', CRLF_PROJECT, '--json'], 'init into a project whose CLAUDE.md has Windows line endings');
  must(r.status === 0, `exit ${r.status}`);
  const text = fs.readFileSync(path.join(CRLF_PROJECT, 'CLAUDE.md'), 'utf8');
  must(text.startsWith(CRLF_BEFORE), 'the text that was there changed');
  must(count(path.join(CRLF_PROJECT, 'CLAUDE.md')) === 1 && /search the vault index first/.test(text), 'the rule is missing or doubled');
  must(!/[^\r]\n/.test(text) && !text.startsWith('\n'), `the file now mixes line endings: ${JSON.stringify(text.slice(0, 120))}`);
  const twice = vm(['init', VAULT, '--project', CRLF_PROJECT, '--json'], 'and again');
  must(twice.json.ruleFiles.every((/** @type {any} */ x) => x.action === 'unchanged') && fs.readFileSync(path.join(CRLF_PROJECT, 'CLAUDE.md'), 'utf8') === text, 'a second run changed the file');
  vm(['init', VAULT, '--project', PROJECT, '--json'], 'init (back to the first project)');
  return 'one rule block each; Windows line endings kept';
});

step('first sync', () => {
  const r = vm(['sync', '--json'], 'first sync');
  vm(['sync'], 'sync again (as a person sees it)');
  must(r.status === 0, `exit ${r.status}: ${(r.stdout + r.stderr).slice(0, 400)}`);
  must(r.json.inStep === true, 'not in step after the sync');
  return `${r.json.counts.added} notes, ${r.json.passages.total} passages in ${r.json.seconds} s`;
});

let engineLine = '';
step('status says in step', () => {
  const human = vm(['status']);
  const r = vm(['status', '--json'], 'status');
  const v = vm(['status', '--verify', '--json'], 'status --verify');
  must(r.status === 0 && r.json.inStep === true, `status: exit ${r.status}, inStep ${r.json && r.json.inStep}`);
  must(v.status === 0 && v.json.inStep === true, `status --verify: exit ${v.status}, inStep ${v.json && v.json.inStep}; failing checks: ${v.json ? v.json.checks.filter((/** @type {any} */ c) => !c.ok).map((/** @type {any} */ c) => c.name).join(',') : '?'}`);
  must(/In step: yes/.test(human.stdout), 'the plain status did not say "In step: yes"');
  must(r.json.counts.notesIndexed === Object.keys(NOTES).length, `indexed ${r.json.counts.notesIndexed} of ${Object.keys(NOTES).length}; left out: ${JSON.stringify(r.json.counts.leftOut)}`);
  engineLine = JSON.stringify(r.json.versions || {});
  return `${r.json.counts.notesIndexed} notes on disk = ${r.json.counts.notesIndexed} in the index; ${v.json.checks.length} checks in --verify`;
});

/** Search and return the hit for one note. */
function find(/** @type {string[]} */ wordings, /** @type {string} */ wantPath, /** @type {string} */ label) {
  const r = vm(['search', ...wordings, '--json'], label);
  must(r.status === 0, `exit ${r.status}: ${(r.stdout + r.stderr).slice(0, 300)}`);
  const all = [...(r.json.results || []), ...(r.json.exactWords || [])];
  const hit = all.find((/** @type {any} */ x) => x.vaultPath === wantPath);
  must(hit, `"${wordings[0]}" did not return ${wantPath}; got ${all.map((/** @type {any} */ x) => x.vaultPath).join(', ')}`);
  return { hit, r };
}

step('search returns the passage, with a working way back to the note', () => {
  const { hit, r } = find(['when do the tomatoes go outside', 'tomato seedlings after the last frost'], 'Garden plan.md', 'search');
  vm(['search', 'when do the tomatoes go outside'], 'search (as a person sees it)');
  must(/last frost/.test(hit.text), `the passage text is missing: ${String(hit.text).slice(0, 120)}`);
  must(fs.existsSync(hit.path) && fs.realpathSync.native(hit.path) === path.join(VAULT, 'Garden plan.md'), `the file path does not lead to the note: ${hit.path}`);
  must(hit.line > 0, 'no line number');
  const link = new URL(hit.link);
  must(link.protocol === 'obsidian:', `link: ${hit.link}`);
  must(String(link.searchParams.get('file')).split('#')[0] === 'Garden plan.md', `link file: ${hit.link}`);
  // The id is the same on every system (forward slashes). The path is this system's own, and it opens.
  must(path.isAbsolute(hit.path) && hit.path === path.join(VAULT, 'Garden plan.md') && fs.existsSync(hit.path), `path: ${hit.path}`);
  if (process.platform === 'win32') must(/^[A-Za-z]:\\/.test(hit.path) && !hit.path.includes('/'), `not a Windows path: ${hit.path}`);
  must(link.searchParams.get('vault') === 'My Vault (work)', `link vault: ${hit.link}`);
  must(/^obsidian:\/\/open\?vault=[A-Za-z0-9%._~-]+&file=[A-Za-z0-9%._~-]+$/.test(hit.link), `the link is not fully encoded: ${hit.link}`);
  for (const x of [...r.json.results, ...r.json.exactWords]) must(!x.vaultPath.includes('\\') && !x.passage.includes('\\'), `an id holds a backslash: ${x.passage}`);
  const engine = r.json.engine || r.json.searched?.engine || '';
  return `link ${hit.link}${engine ? `; engine ${engine}` : ''}`;
});

step('notes with non-English letters are found, and their links decode back', () => {
  for (const [q, want] of /** @type {[string, string][]} */ ([['Birchermüesli at the café', 'Café Zürich notes.md'], ['lentejas con chorizo', 'Recetas/Año nuevo señor Peña.md'], ['prune the roses in spring', '日本語/庭の手入れ.md'], ['beefsteak tomatoes in a zinc bathtub', 'Seeds \u{1F331}/Tomato \u{1F345} log.md'], ['north pier lighthouse', 'Work/Meeting notes 2031-03-04.md']])) {
    const { hit } = find([q], want, `search ${want}`);
    must(fs.existsSync(hit.path), `path does not exist: ${hit.path}`);
    must(!hit.vaultPath.includes('\\'), `the id holds a backslash: ${hit.vaultPath}`);
    must(String(new URL(hit.link).searchParams.get('file')).split('#')[0] === want, `the link for ${want} decodes to ${new URL(hit.link).searchParams.get('file')}`);
    must(!/\r/.test(hit.text), 'a passage kept a carriage return');
  }
  // The name with separate accent marks: one spelling in the id and the link, the disk's own spelling in the path.
  const mac = 'Mac names/Cre\u0301me bru\u0302le\u0301e.md';
  const { hit } = find(['who torches the sugar with a brass blowlamp'], mac.normalize('NFC'), 'search a name with separate accent marks');
  must(fs.existsSync(hit.path), `path does not exist: ${hit.path}`);
  must(fs.readdirSync(path.dirname(hit.path)).includes(path.basename(hit.path)) && path.basename(hit.path) === mac.split('/')[1], `the path is not the name the folder lists: ${hit.path}`);
  must(fs.readFileSync(hit.path, 'utf8').includes('brass blowlamp'), 'the path opens another file');
  must(String(new URL(hit.link).searchParams.get('file')).split('#')[0] === mac.normalize('NFC'), `the link decodes to ${new URL(hit.link).searchParams.get('file')}`);
  return '6 notes, each found by its own words (accents, Japanese, an emoji); a name with separate accent marks opens by its path';
});

step('edit a note, sync again, search finds the new text', () => {
  const p = path.join(VAULT, 'Garden plan.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8') + '\n## Bees\n\nThe invented kestrel hive gets a second brood box when the lime trees flower.\n');
  expected = snapshot(); // this script's own edit
  const stale = vm(['status', '--json'], 'status after an edit');
  must(stale.json.inStep === false, 'status still said in step after an edit');
  const r = vm(['sync', '--json'], 'sync after one edit');
  must(r.status === 0 && r.json.inStep === true, `exit ${r.status}`);
  must(r.json.counts.updated === 1, `updated ${r.json.counts.updated} notes, wanted 1`);
  const { hit } = find(['second brood box for the kestrel hive'], 'Garden plan.md', 'search after the edit');
  must(/brood box/.test(hit.text), 'the new text is not in the passage');
  return `1 note updated, ${r.json.passages.embedded} passages read again, in ${r.ms} ms`;
});

step('rename a note in letter case only, sync: one note, under its new name', () => {
  const before = vm(['status', '--json'], 'status before the rename').json.counts.notesIndexed;
  fs.renameSync(path.join(VAULT, 'Garden plan.md'), path.join(VAULT, 'garden plan.md'));
  must(fs.readdirSync(VAULT).includes('garden plan.md') && !fs.readdirSync(VAULT).includes('Garden plan.md'), 'this system did not rename the file');
  expected = snapshot();
  const r = vm(['sync', '--json'], 'sync after a rename in letter case only');
  must(r.status === 0 && r.json.inStep === true, `exit ${r.status}, inStep ${r.json && r.json.inStep}`);
  must(r.json.counts.renamed === 1 && r.json.counts.added === 0 && r.json.counts.removed === 0, `counts: ${JSON.stringify(r.json.counts)}`);
  const st = vm(['status', '--verify', '--json'], 'status --verify after the rename');
  must(st.json.inStep === true && st.json.counts.notesIndexed === before, `notes in the index: ${st.json.counts.notesIndexed}, wanted ${before}`);
  const s = vm(['search', 'second brood box for the kestrel hive', '--json']);
  const all = [...s.json.results, ...s.json.exactWords].filter((/** @type {any} */ x) => x.vaultPath.toLowerCase() === 'garden plan.md');
  must(all.length > 0 && all.every((/** @type {any} */ x) => x.vaultPath === 'garden plan.md'), `the note is listed as ${all.map((/** @type {any} */ x) => x.vaultPath).join(', ') || 'nothing'}`);
  must(fs.readdirSync(VAULT).includes(path.basename(all[0].path)), `the path is not the name on disk: ${all[0].path}`);
  return `renamed 1; still ${before} notes`;
});

step('a note at a path longer than 260 characters is read and found, and its path opens', () => {
  const rel = ['Long', ...Array.from({ length: 6 }, (_, i) => `A folder with a long name, number ${i + 1}, as an archive grows them`), 'The clock tower.md'];
  const abs = path.join(VAULT, ...rel);
  must(abs.length > 300, `the path is only ${abs.length} characters`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '# The clock tower\n\nThe invented clockmaker oils the tower mechanism every Michaelmas and winds it with a walnut crank.\n');
  expected = snapshot();
  const r = vm(['sync', '--json'], 'sync with a very long path');
  const human = vm(['status'], 'status with a very long path');
  must(!/\n\s+at .+:\d+/.test(r.stdout + r.stderr + human.stdout + human.stderr), 'a stack trace was printed');
  must(r.status === 0 && r.json.inStep === true && r.json.counts.added === 1, `exit ${r.status}: ${(r.stdout + r.stderr).slice(0, 400)}`);
  const { hit } = find(['who oils the tower mechanism at Michaelmas'], rel.join('/'), 'search a very long path');
  must(hit.path === abs && fs.existsSync(hit.path) && fs.readFileSync(hit.path, 'utf8').includes('walnut crank'), `the path does not open: ${hit.path}`);
  return `${abs.length} characters`;
});

// A note another program holds. On Windows a virus scanner or an editor can hold a file so that nobody else may
// read it; a second process does that here. Elsewhere the note's read permission is taken away for a moment.
const HELD = path.join(VAULT, 'Work', 'Meeting notes 2031-03-04.md');
fs.appendFileSync(HELD, '\r\nThe invented committee also ordered forty fathoms of tarred rope.\r\n');
expected = snapshot();
/** @type {import('node:child_process').ChildProcess | null} */
let holder = null;
let held = '';
if (process.platform === 'win32') {
  holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$f = [System.IO.File]::Open($env:VM_HELD_FILE, 'Open', 'ReadWrite', 'None'); [Console]::Out.WriteLine('held'); Start-Sleep -Seconds 600"], { env: { ...process.env, VM_HELD_FILE: HELD }, stdio: ['ignore', 'pipe', 'inherit'] });
  const h = holder;
  held = await new Promise((resolve) => { let out = ''; h.stdout?.on('data', (d) => { out += d; if (out.includes('held')) resolve('held open by another process, with no sharing'); }); h.on('exit', () => resolve('')); setTimeout(() => resolve(''), 60000); });
} else if (process.getuid && process.getuid() !== 0) { fs.chmodSync(HELD, 0o000); held = 'read permission taken away'; }
const canRead = () => { try { fs.readFileSync(HELD); return true; } catch { return false; } };
/** The tool, with no checksum listing afterwards: this script cannot read the held note either. */
const raw = (/** @type {string[]} */ args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: PROJECT, env: { ...process.env, NO_COLOR: '1', VAULT_MIRROR_OBSIDIAN_JSON: OBS_JSON, ...(HOME ? { VAULT_MIRROR_HOME: HOME } : {}) }, encoding: 'utf8', timeout: 900000 });
  console.log(`\n$ vault-mirror ${args.join(' ')}    [exit ${r.status}]`);
  if ((r.stdout + r.stderr).trim()) console.log((r.stdout + r.stderr).trimEnd().split('\n').map((l) => `  ${l}`).join('\n'));
  let json = null; if (args.includes('--json')) { try { json = JSON.parse(r.stdout); } catch { json = null; } }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
};
step('a changed note that another program holds: sync skips it and says so, and nothing claims to be in step', () => {
  try {
    must(held && !canRead(), `this run could not make a note unreadable (${held || 'no way to on this system'})`);
    const r = raw(['sync', '--json']);
    const human = raw(['sync']);
    const st = raw(['status', '--json']);
    must(!/\n\s+at .+:\d+/.test(r.stdout + r.stderr + human.stdout + human.stderr), 'a stack trace was printed');
    must(r.json && r.json.inStep === false, `sync said in step: ${r.stdout.slice(0, 300)}`);
    must(r.json.skippedNotes.length === 1 && r.json.skippedNotes[0].path === 'Work/Meeting notes 2031-03-04.md' && r.json.skippedNotes[0].reason === 'unreadable', `skipped: ${JSON.stringify(r.json.skippedNotes)}`);
    must(/In step: not yet\. 1 note could not be read\. Run vault-mirror sync again\./.test(human.stdout), `the plain words are missing: ${human.stdout.slice(0, 300)}`);
    must(st.json && st.json.inStep === false, 'status said in step while a changed note could not be read');
    // What the index held for that note before is still there: a held note is never treated as deleted.
    const s = raw(['search', 'north pier lighthouse', '--no-sync', '--json']);
    must(s.json.results.some((/** @type {any} */ x) => x.vaultPath === 'Work/Meeting notes 2031-03-04.md'), 'the held note left the index');
  } finally {
    // This script's own helper, stopped by its own process id.
    if (holder) { const h = holder; h.kill(); const until = Date.now() + 15000; while (!canRead() && Date.now() < until) spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 200)']); }
    else if (held) fs.chmodSync(HELD, 0o644);
  }
  must(canRead() && snapshot() === expected, 'the vault differs from its checksum listing after the note was let go');
  const after = vm(['sync', '--json'], 'sync once the note is let go');
  must(after.status === 0 && after.json.inStep === true && after.json.counts.updated === 1 && after.json.skippedNotes.length === 0, `after: ${JSON.stringify(after.json && after.json.counts)}`);
  find(['forty fathoms of tarred rope'], 'Work/Meeting notes 2031-03-04.md', 'search the note once it is let go');
  return `${held}; skipped and named, then read on the next sync`;
});

step('delete a note, sync, it is gone from search', () => {
  fs.rmSync(path.join(VAULT, 'Café Zürich notes.md'));
  expected = snapshot();
  const r = vm(['sync', '--json'], 'sync after a delete');
  must(r.status === 0 && r.json.inStep === true, `exit ${r.status}`);
  const s = vm(['search', 'Birchermüesli at the café', '--json']);
  must(![...(s.json.results || []), ...(s.json.exactWords || [])].some((/** @type {any} */ x) => x.vaultPath === 'Café Zürich notes.md'), 'a deleted note is still returned');
  return 'removed';
});

step('rebuild, then still in step', () => {
  const r = vm(['rebuild', '--json'], 'rebuild');
  must(r.status === 0 && r.json.inStep === true, `exit ${r.status}: ${(r.stdout + r.stderr).slice(0, 300)}`);
  const v = vm(['status', '--verify', '--json']);
  must(v.json.inStep === true, 'not in step after rebuild');
  find(['when do the tomatoes go outside'], 'garden plan.md', 'search after rebuild');
  return `mode ${r.json.mode}`;
});

step('rebuild --full: the index is made again from the notes, in the same place, with nothing left over', () => {
  const dataFolders = () => fs.readdirSync(INDEX_DIR).filter((n) => /^data-\d+$/.test(n));
  const before = dataFolders();
  const r = vm(['rebuild', '--full', '--yes', '--json'], 'rebuild --full');
  must(r.status === 0 && r.json.inStep === true, `exit ${r.status}: ${(r.stdout + r.stderr).slice(0, 300)}`);
  const after = dataFolders();
  must(after.length === 1 && !before.includes(after[0]), `data folders before ${before.join(',')}, after ${after.join(',')}`);
  const v = vm(['status', '--verify', '--json'], 'status --verify after rebuild --full');
  must(v.json.inStep === true, 'not in step after rebuild --full');
  find(['who oils the tower mechanism at Michaelmas'], v.json && 'Long/' + Array.from({ length: 6 }, (_, i) => `A folder with a long name, number ${i + 1}, as an archive grows them`).join('/') + '/The clock tower.md', 'search after rebuild --full');
  must(!fs.readdirSync(VAULT).some((n) => /^data-|\.vault-mirror|CURRENT/.test(n)), 'an index file is in the vault');
  return `${r.json.passages} passages read again; one data folder`;
});

step('doctor at the end', () => {
  const r = vm(['doctor', '--json'], 'doctor at the end');
  vm(['doctor']);
  const failed = r.json ? r.json.checks.filter((/** @type {any} */ c) => c.status === 'fail').map((/** @type {any} */ c) => c.name) : ['no JSON'];
  must(r.status === 0 && failed.length === 0, `exit ${r.status}; failed checks: ${failed.join(', ')}`);
  return 'no failed check';
});

step('not one file in the vault changed', () => {
  must(snapshot() === expected, 'the vault differs from its checksum listing');
  must(!fs.readdirSync(VAULT).some((n) => /vault-mirror|ruvector|\.db$/.test(n)), 'a tool file is in the vault');
  return `checksum listing identical after ${checks} commands`;
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} first-run steps passed on ${process.platform} (node ${process.version})${failed.length ? `; FAILED: ${failed.map((f) => f.name).join('; ')}` : ''}.`);
console.log(`Timings (ms): ${JSON.stringify(timings)}`);
if (engineLine) console.log(`Versions: ${engineLine}`);
if (!opt.keep) { try { fs.rmSync(base, { recursive: true, force: true }); } catch { console.log(`Could not remove ${base}`); } } else console.log(`Kept: ${base}`);
process.exit(failed.length ? 1 : 0);
