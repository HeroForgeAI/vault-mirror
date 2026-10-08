// @ts-check
// doctor: is this computer ready? Each check is ok, warn, info or fail, with one next action.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeDir, loadConfig, indexDirFor, chooseWorkers } from '../../config/config.js';
import { checkOneVault, checkIndexOutside, inCloudFolder, CLOUD_VAULT_NOTE, CLOUD_HOME_NOTE } from '../../config/guards.js';
import { resolveSafe, tildify } from '../../config/paths.js';
import { configureWriter, ensureDir, remove, writeFile } from '../../store/safe-write.js';
import { clearIfStale, liveOwner } from '../../store/lock.js';
import { loadManifest } from '../../store/manifest.js';
import { computeStatus } from '../../status/checks.js';
import { lookupVault } from '../../vault/obsidian-registry.js';
import { walkVault } from '../../vault/walk.js';
import { createEmbedder } from '../../embed/embedder.js';
import { modelFiles } from '../../embed/model.js';
import { modelEntry } from '../../embed/models.js';
import { loadedVersions, isNative } from '../../engine/ruvector-loader.js';
import { createFlat } from '../../engine/ruvector-flat.js';
import { flatSelfTest } from '../../engine/selftest.js';
import { createExact } from '../../engine/exact.js';
import { RULE_START } from '../../rule-text.js';
import { VmError } from '../../errors.js';
import { debug, setLogDir } from '../../log.js';
import { PINS } from '../../version.js';
import { duration, num } from '../output.js';

/** @typedef {{ name: string, status: 'ok' | 'warn' | 'info' | 'fail', message: string, next: string | null }} Check */

/** A deterministic unit vector. @param {number} dimensions @param {number} seed */
function fakeVector(dimensions, seed) {
  const v = new Float32Array(dimensions);
  let x = (seed * 2654435761) % 2 ** 31; let n = 0;
  for (let i = 0; i < dimensions; i++) { x = (x * 1103515245 + 12345) % 2 ** 31; v[i] = x / 2 ** 30 - 1; n += v[i] * v[i]; }
  n = Math.sqrt(n);
  return v.map((y) => y / n);
}

/** @param {import('../output.js').Ui} ui */
export async function doctorCommand(ui) {
  /** @type {Check[]} */
  const checks = [];
  const add = (/** @type {string} */ name, /** @type {Check['status']} */ status, /** @type {string} */ message, /** @type {string | null} */ next = null) => {
    checks.push({ name, status, message, next });
    ui.out(`${status.padEnd(4)}  ${message}${next && status !== 'ok' ? `\n      Next: ${next}` : ''}`);
  };
  const home = homeDir();
  const cfg = loadConfig(home);
  /** @type {{ passagesPerSecond: number | null, firstSyncSeconds: number | null }} */
  const estimate = { passagesPerSecond: null, firstSyncSeconds: null };

  // Node
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) add('node', 'fail', new VmError('VM_E_NODE_OLD', { version: process.versions.node }).message, 'Install the current Node from nodejs.org, then run `vault-mirror doctor`.');
  else if (major < 22) add('node', 'warn', `Node ${process.versions.node} works, but this was only measured on newer versions.`, 'Install the current Node from nodejs.org when convenient.');
  else add('node', 'ok', `Node ${process.versions.node}.`);

  // Engine and pins
  const native = isNative();
  add('engine', native ? 'ok' : 'warn', native ? `The fast engine loaded for ${process.platform} ${process.arch}.` : `There is no fast engine for ${process.platform} ${process.arch}, so the built-in exact search will be used. Results are the same.`, native ? null : 'Nothing to do. Searches still work.');
  const loaded = loadedVersions();
  const pinsOk = loaded.ruvector === PINS.ruvector && loaded.core === PINS.core && (!native || loaded.native === PINS.native);
  add('pinned-versions', pinsOk ? 'ok' : 'warn', `Loaded ruvector ${loaded.ruvector}, @ruvector/core ${loaded.core}, native ${loaded.native ?? 'none'}${pinsOk ? '.' : ` (tested with ${PINS.ruvector}, ${PINS.core}, ${PINS.native}).`}`, pinsOk ? null : 'Install vault-mirror again so the tested versions are used.');

  // Home folder
  let vaultReal = null; let homeOk = true;
  if (cfg.vault) { try { vaultReal = checkOneVault(cfg.vault.path).real; } catch { vaultReal = null; } }
  try {
    if (vaultReal) checkIndexOutside(vaultReal, home);
    configureWriter({ home, vault: vaultReal });
    ensureDir(home);
    const probe = path.join(home, `.doctor-${process.pid}`);
    writeFile(probe, 'ok'); remove(probe);
    const real = resolveSafe(home);
    /** @type {number | null} */
    let freeMB = null;
    try { const s = fs.statfsSync(home); freeMB = Math.round((s.bavail * s.bsize) / 1e6); } catch { freeMB = null; }
    if (inCloudFolder(real)) add('home-folder', 'warn', CLOUD_HOME_NOTE, 'Set VAULT_MIRROR_HOME to a folder that does not sync.');
    else if (freeMB != null && freeMB < 500) add('home-folder', 'warn', `Only ${num(freeMB)} MB is free where the index lives (${tildify(home)}).`, 'Free about 500 MB.');
    else add('home-folder', 'ok', `The index folder ${tildify(home)} is writable and outside your vault.`);
  } catch (e) {
    homeOk = false;
    const inVault = e instanceof VmError && e.code === 'VM_E_INDEX_IN_VAULT';
    add('home-folder', 'fail', inVault ? e.message : `The index folder ${tildify(home)} cannot be written.`, inVault ? e.next : 'Set VAULT_MIRROR_HOME to a folder you can write to.');
  }
  if (homeOk) setLogDir(path.join(home, 'logs'));

  // Vault and Obsidian
  let notes = 0;
  if (!cfg.vault) add('vault', 'info', 'No vault yet.', 'vault-mirror init "<path to your vault>"');
  else if (!vaultReal) add('vault', 'fail', `The vault folder was not found at ${tildify(cfg.vault.path)}, or it is not one vault.`, 'Run `vault-mirror init` with the folder of the one vault you want.');
  else {
    try {
      notes = walkVault(vaultReal, { exclude: cfg.vault.exclude, obsidianExcludes: cfg.vault.obsidianExcludes }).notes.length;
      if (inCloudFolder(vaultReal)) add('vault', 'warn', CLOUD_VAULT_NOTE, 'Nothing to do.');
      else add('vault', 'ok', `The vault ${tildify(vaultReal)} is readable (${num(notes)} notes).`);
    } catch { add('vault', 'fail', `The vault ${tildify(vaultReal)} could not be read.`, 'Check the folder, then run `vault-mirror doctor`.'); }
    const reg = lookupVault(vaultReal);
    if (reg.state === 'registered') add('obsidian', reg.vaultParam === path.basename(vaultReal) ? 'ok' : 'warn', reg.vaultParam === path.basename(vaultReal) ? 'Obsidian knows this vault, so links to notes will open.' : 'Two vaults in Obsidian share this folder name. Links use the vault id instead, and still open.', reg.vaultParam === path.basename(vaultReal) ? null : 'Nothing to do.');
    else add('obsidian', 'warn', 'Obsidian has not opened this vault on this computer, so links to notes will not open yet.', 'Open this folder as a vault in Obsidian once.');
  }

  // Has this vault been synced, and is it in step? Asked the way `status` asks, so "in step" means one thing.
  let synced = false; let inStep = false;
  if (vaultReal && homeOk && cfg.vault) {
    try {
      const indexDir = indexDirFor(home, vaultReal);
      if (loadManifest(indexDir)) {
        synced = true;
        const ctx = { home, cfg, vault: { real: vaultReal, name: path.basename(vaultReal), opened: true }, indexDir };
        inStep = (await computeStatus(/** @type {any} */ (ctx), {}, /** @type {any} */ ({ warn() {}, warnings: [] }))).inStep;
      }
    } catch (e) { debug(`doctor could not check whether the vault is in step: ${String(/** @type {any} */ (e)?.message).slice(0, 160)}`); }
  }

  // Model and embedding
  const entry = modelEntry(cfg.embedding.model);
  const embedder = createEmbedder({ model: cfg.embedding.model, debug, notice: (line) => ui.info(line) });
  let modelOk = false;
  try {
    await embedder.init();
    modelOk = true;
    const tested = embedder.tested();
    add('model', tested ? 'ok' : 'warn', tested ? 'The reading model is on this computer and matches the tested files.' : 'The reading model loads, but its files differ from the ones this version was tested with. It still runs.', tested ? null : 'Nothing to do. If searches look wrong, run `vault-mirror rebuild --full`.');
  } catch (e) {
    const err = e instanceof VmError ? e : new VmError('VM_E_MODEL_BROKEN', { path: modelFiles(entry).dir });
    add('model', 'fail', err.message, err.next);
  }
  if (modelOk) {
    try {
      const dims = embedder.dimensions;
      const base = 'The gardener waters the tomato plants every morning before the sun gets too warm.';
      const one = await embedder.embedQuery(base);
      let norm = 0; for (const x of one) norm += x * x;
      const unitLength = Math.abs(Math.sqrt(norm) - 1) < 1e-3 && one.length === dims && one.every(Number.isFinite);
      // A sentence plus a long tail past the window gives the same vector; a full passage changes when its last word changes.
      const filler = Array.from({ length: 400 }, (_, i) => `word${i % 7}`).join(' ');
      let full = ''; for (const w of filler.split(' ')) { if (embedder.countTokens(`${full} ${w}`) > embedder.windowTokens) break; full = full ? `${full} ${w}` : w; }
      const [atWindow, pastWindow, changedLast] = await embedder.embedPassages([full, `${full} zebra giraffe ${filler}`, full.replace(/\S+$/, 'zebra')]);
      const same = (/** @type {Float32Array | null} */ a, /** @type {Float32Array | null} */ b) => Boolean(a && b && a.every((x, i) => Math.abs(x - b[i]) < 1e-6));
      const windowOk = same(atWindow, pastWindow) && !same(atWindow, changedLast);
      if (unitLength && windowOk) add('embedding', 'ok', `A sentence reads into ${num(dims)} numbers, and the model's reading window matches the token counter.`);
      else add('embedding', 'fail', unitLength ? 'The token counter and the reading model disagree about how much of a passage is read.' : 'The reading model returned a vector that is not usable.', 'Delete the folder ' + modelFiles(entry).dir + ', then run `vault-mirror doctor`.');
      const sample = Array.from({ length: 32 }, (_, i) => `${base} Row ${i} of the garden holds beans, squash and a few stubborn carrots.`);
      const t = Date.now(); await embedder.embedPassages(sample);
      const single = 32 / Math.max(0.001, (Date.now() - t) / 1000);
      const { workers } = chooseWorkers(cfg.vault ? cfg.vault.workers : 'auto');
      const rate = single * Math.max(1, workers);
      estimate.passagesPerSecond = Math.round(rate * 10) / 10;
      // The first-sync estimate is only for a vault that has not been synced yet.
      if (vaultReal && notes && !synced) {
        // A rough stand-in used only for this estimate: about 55 words to a passage.
        let bytes = 0; for (const n of walkVault(vaultReal, { exclude: cfg.vault?.exclude }).notes) bytes += n.size;
        const passages = Math.max(notes, Math.round(bytes / 6 / 55));
        estimate.firstSyncSeconds = Math.round(passages / rate);
        add('speed', 'info', `About ${Math.round(single)} passages a second with one reader here, so a first sync of this vault should take about ${duration(estimate.firstSyncSeconds)} with ${Math.max(1, workers)} ${workers > 1 ? 'readers' : 'reader'}. Later syncs only read what changed.`);
      } else add('speed', 'info', `About ${Math.round(single)} passages a second with one reader on this computer.`);
    } catch (e) {
      debug(`doctor embedding check: ${String(/** @type {any} */ (e)?.message).slice(0, 160)}`);
      add('embedding', 'fail', 'The reading model loaded but could not read a sentence.', 'Delete the folder ' + modelFiles(entry).dir + ', then run `vault-mirror doctor`.');
    }
  }
  await embedder.shutdown();

  // Engine is flat, and its round trip agrees with an exact scan.
  if (native && homeOk) {
    const dims = embedder.dimensions;
    const tmp = path.join(home, `doctor-${process.pid}`);
    try {
      ensureDir(tmp);
      const { engine, flat } = await createFlat(path.join(tmp, 'check.db'), dims);
      await flatSelfTest(engine, dims, flat === undefined ? path.join(tmp, 'check.db') : () => flat);
      add('engine-is-flat', 'ok', 'A new index is created exact (flat): a replaced passage is found once, and a deleted one is gone.');
      const rows = Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, vector: fakeVector(dims, i + 1) }));
      const outlier = new Float32Array(dims); outlier[3] = -1; rows[77] = { id: 'p77', vector: outlier };
      await engine.insert(rows);
      const all = new Float32Array(200 * dims); rows.forEach((r, i) => all.set(r.vector, i * dims));
      const exact = createExact(all, (i) => `p${i}`, dims);
      let agree = true;
      for (const q of [rows[5].vector, outlier, fakeVector(dims, 999)]) {
        const a = await engine.search(q, 10); const b = await exact.search(q, 10);
        if (a.length !== b.length || a.some((h, i) => Math.abs(h.score - b[i].score) > 1e-4) || a[0].id !== b[0].id) agree = false;
      }
      add('engine-round-trip', agree ? 'ok' : 'fail', agree ? 'The engine\'s top results equal an exact scan\'s.' : 'The engine\'s results differ from an exact scan.', agree ? null : 'Install vault-mirror again so the tested versions are used.');
    } catch (e) {
      const notFlat = /** @type {any} */ (e)?.code === 'VM_E_ENGINE_NOT_FLAT';
      debug(`doctor engine check: ${String(/** @type {any} */ (e)?.code || '')} ${String(/** @type {any} */ (e)?.message).slice(0, 160)}`);
      add('engine-is-flat', 'fail', notFlat ? 'A new index did not pass the exact-index check (VM_E_ENGINE_NOT_FLAT). The built-in exact search will be used instead.' : 'A test index could not be created.', 'Install vault-mirror again so the tested versions are used.');
    } finally { try { remove(tmp); } catch { /* removed at next run */ } }
  }

  // Locks, rule, old indexes
  if (vaultReal && homeOk) {
    const indexDir = indexDirFor(home, vaultReal);
    for (const name of ['sync.lock', 'index.lock']) {
      const file = path.join(indexDir, name);
      const owner = liveOwner(file);
      if (owner) add(name, 'info', `A ${owner.command} is running right now (process ${owner.pid}).`, 'Wait for it to finish.');
      else if (clearIfStale(file)) add(name, 'ok', `Cleared a leftover ${name} from a run that had ended.`);
    }
    if (!checks.some((c) => c.name.endsWith('.lock'))) add('locks', 'ok', 'No leftover locks.');
    const m = loadManifest(indexDir);
    if (m) add('index', 'info', `The index holds ${num(m.manifest.totals.notes)} notes (${num(m.manifest.totals.passages)} passages).`);
  }
  const rule = ['CLAUDE.md', 'AGENTS.md'].map((f) => { try { return fs.readFileSync(path.join(process.cwd(), f), 'utf8').includes(RULE_START); } catch { return false; } });
  add('rule', 'info', rule[0] || rule[1] ? `The vault rule is in ${[rule[0] ? 'CLAUDE.md' : null, rule[1] ? 'AGENTS.md' : null].filter(Boolean).join(' and ')} in this folder.` : 'The vault rule is not in this folder\'s CLAUDE.md or AGENTS.md.', rule[0] || rule[1] ? null : 'In your project folder, run `vault-mirror init "<path to your vault>"`.');
  try {
    const dir = path.join(home, 'indexes');
    const old = [];
    for (const name of fs.readdirSync(dir)) {
      const m = loadManifest(path.join(dir, name));
      if (m && !fs.existsSync(m.manifest.vault.path)) old.push(name);
    }
    if (old.length) add('old-indexes', 'info', `${old.length} index ${old.length === 1 ? 'folder belongs' : 'folders belong'} to a vault that is no longer at its old place: ${old.join(', ')}. A vault that was moved starts a fresh index.`, `Delete ${old.length === 1 ? 'that folder' : 'those folders'} in ${tildify(dir)} if you no longer need ${old.length === 1 ? 'it' : 'them'}.`);
  } catch { /* no indexes yet */ }

  const failed = checks.filter((c) => c.status === 'fail').length;
  ui.out('');
  ui.out(failed ? `${failed} ${failed === 1 ? 'check' : 'checks'} failed. Follow the first "Next" above.` : !cfg.vault ? 'Ready. Next: vault-mirror init "<path to your vault>"' : inStep ? 'Ready. Your vault is in step.' : 'Ready. Next: vault-mirror sync');
  void os;
  return { vault: vaultReal ? { name: path.basename(vaultReal), path: vaultReal } : null, body: { checks, estimate }, exitCode: failed ? 5 : 0 };
}
