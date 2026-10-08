// @ts-check
// ruvector as the engine, created with the flat (exact) index. Never the default index:
// in the published binary it loses rows, keeps deleted passages and can return a note twice.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRuvector, isNative } from './ruvector-loader.js';
import { similarity } from './engine.js';
import { VmError } from '../errors.js';

/** One spelling of the path: the real parent folder plus the file name. @param {string} file */
function oneSpelling(file) {
  const abs = path.resolve(file);
  const name = path.basename(abs);
  if (name === 'ruvector.db' || name === 'kb.db') throw new Error('an engine file is never named ruvector.db or kb.db');
  return path.join(fs.realpathSync.native(path.dirname(abs)), name);
}

/** @param {() => any} open */
async function retryBusy(open) {
  const end = Date.now() + 10000; let wait = 100;
  for (;;) {
    try { return open(); }
    catch (e) {
      if (!/already open|acquire lock/i.test(String(/** @type {any} */ (e)?.message))) throw e;
      if (Date.now() > end) throw new VmError('VM_E_INDEX_BUSY');
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 2, 1000);
    }
  }
}

/**
 * @param {any} db @returns {import('./engine.js').Engine}
 */
function wrap(db) {
  return {
    name: 'ruvector-flat',
    async insert(rows) {
      for (let i = 0; i < rows.length; i += 2000) await db.insertBatch(rows.slice(i, i + 2000).map((r) => ({ id: r.id, vector: r.vector })));
    },
    async remove(ids) { for (const id of ids) await db.delete(id); },
    async search(vector, k) {
      const hits = await db.search({ vector, k });
      return hits.map((/** @type {any} */ h) => ({ id: h.id, score: similarity(h.score) }));
    },
    async has(id) { return (await db.get(id)) != null; },
    async count() { return db.len(); },
    async close() { /* ruvector has no close; its lock frees when the process exits */ },
  };
}

/**
 * Create a new flat index file. The raw binding with no hnswConfig selects the flat index,
 * and the choice is stored in the file.
 *
 * Windows does not let anyone read a file while the engine holds it, not even this process, so the
 * "is it flat" check cannot read the file once it is open here. There the file is created by a short
 * helper process, read once that process has ended, and only then opened; `flat` carries the answer.
 * @param {string} file @param {number} dimensions
 * @param {{ inHelper?: boolean }} [opts]  inHelper defaults to true on Windows only
 * @returns {Promise<{ engine: import('./engine.js').Engine, storagePath: string, flat?: boolean }>}
 */
export async function createFlat(file, dimensions, opts = {}) {
  if (!isNative()) throw Object.assign(new Error('native engine not available'), { code: 'VM_ENGINE_UNAVAILABLE' });
  const storagePath = oneSpelling(file);
  if (fs.existsSync(storagePath)) throw new Error('refusing to create over an existing engine file');
  const rv = loadRuvector();
  if (opts.inHelper ?? process.platform === 'win32') {
    const made = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--create', storagePath, String(dimensions)], { stdio: 'ignore', windowsHide: true, timeout: 30000 });
    if (made.status !== 0) throw new Error(`the helper could not create the engine file (exit ${made.status}${made.signal ? `, ${made.signal}` : ''})`);
    const flat = fileIsFlat(storagePath);
    const db = await retryBusy(() => new rv.VectorDB({ dimensions, storagePath, distanceMetric: 'cosine' }));
    return { engine: wrap(db), storagePath, flat };
  }
  await retryBusy(() => new rv.NativeVectorDb({ dimensions, storagePath, distanceMetric: 'Cosine' }));
  const db = await retryBusy(() => new rv.VectorDB({ dimensions, storagePath, distanceMetric: 'cosine' }));
  return { engine: wrap(db), storagePath };
}

/** Open an existing index file. The caller has already probed it in a child process. @param {string} file @param {number} dimensions */
export async function openFlat(file, dimensions) {
  if (!isNative()) throw Object.assign(new Error('native engine not available'), { code: 'VM_ENGINE_UNAVAILABLE' });
  const storagePath = oneSpelling(file);
  const rv = loadRuvector();
  const db = await retryBusy(() => new rv.VectorDB({ dimensions, storagePath, distanceMetric: 'cosine' }));
  return { engine: wrap(db), storagePath };
}

/** True when the file's bytes say it was created flat. @param {string} file */
export function fileIsFlat(file) {
  const marker = '"hnsw_config":null';
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(4 * 1024 * 1024, fs.fstatSync(fd).size));
    fs.readSync(fd, head, 0, head.length, 0);
    if (head.includes(marker)) return true;
    if (head.includes('"hnsw_config":{')) return false;
  } finally { fs.closeSync(fd); }
  return fs.readFileSync(file).includes(marker);
}

// The helper: node ruvector-flat.js --create <file> <dimensions>. It creates the file and ends, which lets go of it.
if (process.argv[2] === '--create' && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const rv = loadRuvector();
    new rv.NativeVectorDb({ dimensions: Number(process.argv[4]), storagePath: process.argv[3], distanceMetric: 'Cosine' });
    process.exit(0);
  } catch {
    process.exit(3);
  }
}
