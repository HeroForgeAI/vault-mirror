// @ts-check
// Brings the engine in step with the manifest. The engine is a disposable cache of ids and
// vectors: whenever its stamp differs, it is rebuilt from the sidecar. No embedding, no network.
import fs from 'node:fs';
import path from 'node:path';
import { acquireLock } from '../store/lock.js';
import { ensureDir, writeFileAtomic, remove } from '../store/safe-write.js';
import { readVectors } from '../store/sidecar.js';
import { loadManifest } from '../store/manifest.js';
import { createFlat, openFlat } from './ruvector-flat.js';
import { createExact } from './exact.js';
import { flatSelfTest } from './selftest.js';
import { probeEngineFile } from './probe.js';
import { isNative } from './ruvector-loader.js';
import { passageId } from './engine.js';
import { debug } from '../log.js';

/** @param {string} indexDir */
function readCurrent(indexDir) {
  try { return JSON.parse(fs.readFileSync(path.join(indexDir, 'engine', 'CURRENT'), 'utf8')); } catch { return null; }
}

/** The engine's stamp without opening it. @param {string} indexDir */
export function engineStamp(indexDir) {
  const cur = readCurrent(indexDir);
  return cur && fs.existsSync(path.join(indexDir, 'engine', cur.file)) ? { stamp: String(cur.stamp), count: Number(cur.count), file: String(cur.file) } : null;
}

/** position -> id for every live vector. @param {import('../store/manifest.js').Manifest} manifest */
export function idTable(manifest) {
  /** @type {(string | null)[]} */
  const ids = new Array(manifest.sidecar.vectors).fill(null);
  for (const key in manifest.notes) {
    const n = manifest.notes[key];
    for (let i = 0; i < n.passages; i++) ids[n.vec + i] = passageId(key, i);
  }
  return ids;
}

/** @param {{ dataDir: string, manifest: import('../store/manifest.js').Manifest }} loaded @param {number} dimensions */
export function exactFromSidecar(loaded, dimensions) {
  const ids = idTable(loaded.manifest);
  return createExact(readVectors(loaded.dataDir, loaded.manifest.sidecar.vectors, dimensions), (i) => ids[i] ?? null, dimensions);
}

/**
 * @typedef {object} EngineResult
 * @property {import('./engine.js').Engine} engine
 * @property {'used' | 'rebuilt' | 'damaged' | 'applied' | 'exact'} how
 * @property {number} seconds
 * @property {string[]} notices     plain sentences for the person
 * @property {string[]} warnings    codes such as VM_E_ENGINE_NOT_FLAT
 * @property {number} probeMs
 * @property {{ dataDir: string, manifest: import('../store/manifest.js').Manifest }} loaded  what the engine was brought in step with; newer than the caller's when a sync finished meanwhile
 */

/**
 * @param {object} ctx
 * @param {string} ctx.indexDir
 * @param {{ dataDir: string, manifest: import('../store/manifest.js').Manifest }} ctx.loaded
 * @param {number} ctx.dimensions
 * @param {boolean} [ctx.forceRebuild]
 * @param {boolean} [ctx.quiet]                 no "reloaded" notice (the end of a sync, where a load is expected)
 * @param {number} [ctx.lockWaitMs]
 * @param {{ fromStamp: string, removeIds: string[], addRows: import('./engine.js').Row[] } | null} [ctx.delta]  apply just these when the engine sits at fromStamp
 * @param {{ probe?: typeof probeEngineFile, native?: () => boolean, create?: typeof createFlat, open?: typeof openFlat, selfTest?: typeof flatSelfTest }} [ctx.deps]  for tests
 * @returns {Promise<EngineResult>}
 */
export async function ensureEngine(ctx) {
  const started = Date.now();
  const deps = { probe: probeEngineFile, native: isNative, create: createFlat, open: openFlat, selfTest: flatSelfTest, ...(ctx.deps || {}) };
  let loaded = ctx.loaded;
  let { manifest } = loaded;
  let want = manifest.totals.passages;
  const engineDir = path.join(ctx.indexDir, 'engine');
  /** @type {string[]} */
  const notices = []; const warnings = [];
  const secs = () => Math.round((Date.now() - started) / 100) / 10;
  const exact = (/** @type {string} */ why) => {
    notices.push(why);
    return /** @type {EngineResult} */ ({ engine: exactFromSidecar(loaded, ctx.dimensions), how: 'exact', seconds: secs(), notices, warnings, probeMs: 0, loaded });
  };
  if (!deps.native()) return exact('The fast engine is not available on this computer, so the built-in exact search is being used. Results are the same.');

  await acquireLock(path.join(ctx.indexDir, 'index.lock'), { command: 'engine', waitMs: ctx.lockWaitMs ?? 30000, busyCode: 'VM_E_INDEX_BUSY' });
  // A sync may have moved on while this reader waited for the lock. Build from what is saved now:
  // an engine built from the older snapshot would carry the older stamp and make the next search reload it.
  const saved = loadManifest(ctx.indexDir);
  if (saved && saved.manifest.stamp !== manifest.stamp) { loaded = saved; manifest = saved.manifest; want = manifest.totals.passages; }
  ensureDir(engineDir);
  const cur = readCurrent(ctx.indexDir);
  const curFile = cur ? path.join(engineDir, cur.file) : null;
  let damaged = false; let probeMs = 0;

  if (cur && curFile && fs.existsSync(curFile) && !ctx.forceRebuild) {
    const atStamp = cur.stamp === manifest.stamp;
    const canApply = ctx.delta && cur.stamp === ctx.delta.fromStamp && ctx.delta.removeIds.length <= 400;
    if (atStamp || canApply) {
      const probe = await deps.probe(curFile, ctx.dimensions);
      probeMs = probe.ms;
      if (!probe.ok) { damaged = true; debug(`engine probe failed: ${probe.reason}`); }
      else if (probe.flat && atStamp && probe.count === want) {
        const { engine } = await deps.open(curFile, ctx.dimensions);
        return { engine, how: 'used', seconds: secs(), notices, warnings, probeMs, loaded };
      } else if (probe.flat && canApply && ctx.delta && probe.count === cur.count) {
        const { engine } = await deps.open(curFile, ctx.dimensions);
        await engine.remove(ctx.delta.removeIds);
        await engine.insert(ctx.delta.addRows);
        if ((await engine.count()) === want) {
          writeFileAtomic(path.join(engineDir, 'CURRENT'), JSON.stringify({ file: cur.file, stamp: manifest.stamp, count: want }));
          return { engine, how: 'applied', seconds: secs(), notices, warnings, probeMs, loaded };
        }
        debug('engine apply gave the wrong count; rebuilding'); // this process now holds that file open: build under a new name
      }
    }
  }

  // Build a new file from the sidecar.
  const lastNumber = fs.readdirSync(engineDir).map((f) => /^index-(\d+)\.db$/.exec(f)).filter(Boolean).map((m) => Number(/** @type {RegExpExecArray} */ (m)[1])).reduce((a, b) => Math.max(a, b), 0);
  const fileName = `index-${String(lastNumber + 1).padStart(4, '0')}.db`;
  const file = path.join(engineDir, fileName);
  remove(file);
  /** @type {import('./engine.js').Engine} */
  let engine;
  try {
    const made = await deps.create(file, ctx.dimensions);
    engine = made.engine;
    const flat = made.flat; // already read where the open file cannot be (Windows)
    await deps.selfTest(engine, ctx.dimensions, flat === undefined ? file : () => flat);
  } catch (e) {
    const code = /** @type {any} */ (e)?.code;
    if (code === 'VM_E_INDEX_BUSY') throw e;
    debug(`engine could not be created or failed its self-test: ${String(/** @type {any} */ (e)?.message).slice(0, 160)}`);
    try { remove(file); } catch { /* it may be held open */ }
    if (code === 'VM_E_ENGINE_NOT_FLAT') warnings.push('VM_E_ENGINE_NOT_FLAT');
    return exact('The fast engine did not pass its own check, so the built-in exact search is being used. Results are the same.');
  }
  const ids = idTable(manifest);
  const vectors = readVectors(loaded.dataDir, manifest.sidecar.vectors, ctx.dimensions);
  /** @type {import('./engine.js').Row[]} */
  let rows = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!id) continue;
    rows.push({ id, vector: vectors.subarray(i * ctx.dimensions, (i + 1) * ctx.dimensions) });
    if (rows.length === 2000) { await engine.insert(rows); rows = []; }
  }
  if (rows.length) await engine.insert(rows);
  const got = await engine.count();
  if (got !== want) { // checked before switching
    debug(`engine build count ${got} differs from ${want}`);
    return exact('The index could not be loaded cleanly, so the built-in exact search is being used. Next: vault-mirror rebuild');
  }
  writeFileAtomic(path.join(engineDir, 'CURRENT'), JSON.stringify({ file: fileName, stamp: manifest.stamp, count: want }));
  for (const name of fs.readdirSync(engineDir)) {
    if (name !== fileName && name !== 'CURRENT' && /^index-\d+\.db/.test(name)) { try { remove(path.join(engineDir, name)); } catch { /* still open elsewhere */ } }
  }
  const s = secs();
  if (damaged) notices.push(`The index file was damaged. It was rebuilt from saved passages (${s.toFixed(1)} s). Your notes were not touched.`);
  else if (!ctx.quiet) notices.push(`The index was reloaded from saved passages (${s.toFixed(1)} s).`);
  debug(`engine ${damaged ? 'rebuilt after damage' : 'reloaded'} rows=${want} seconds=${s}`);
  return { engine, how: damaged ? 'damaged' : 'rebuilt', seconds: s, notices, warnings, probeMs, loaded };
}
