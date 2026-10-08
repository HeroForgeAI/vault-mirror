import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { configureWriter } from '../../src/store/safe-write.js';
import { createDataDir, openSidecar } from '../../src/store/sidecar.js';
import { newManifest, saveManifest, switchCurrent, loadManifest } from '../../src/store/manifest.js';
import { ensureEngine, idTable, engineStamp } from '../../src/engine/build.js';
import { probeEngineFile } from '../../src/engine/probe.js';
import { flatSelfTest } from '../../src/engine/selftest.js';
import { createExact } from '../../src/engine/exact.js';
import { similarity, parseId, passageId } from '../../src/engine/engine.js';
import { tmpDir } from '../helpers/tmp.mjs';

const DIMS = 4;

/** An in-memory engine. `mode` makes it misbehave the way the default index does. */
function memoryEngine(mode = 'flat') {
  /** @type {{ id: string, vector: Float32Array }[]} */
  let rows = [];
  return {
    name: 'memory', rows: () => rows,
    async insert(/** @type {any[]} */ add) { for (const r of add) { if (mode !== 'duplicates') rows = rows.filter((x) => x.id !== r.id); rows.push({ id: r.id, vector: Float32Array.from(r.vector) }); } },
    async remove(/** @type {string[]} */ ids) { if (mode !== 'tombstones') rows = rows.filter((x) => !ids.includes(x.id)); },
    async search(/** @type {Float32Array} */ q, /** @type {number} */ k) { return rows.map((r) => ({ id: r.id, score: similarity(1 - r.vector.reduce((s, v, i) => s + v * q[i], 0)) })).sort((a, b) => b.score - a.score).slice(0, k); },
    async has(/** @type {string} */ id) { return rows.some((r) => r.id === id); },
    async count() { return rows.length; },
    async close() {},
  };
}

function setup() {
  const home = tmpDir('engine');
  configureWriter({ home });
  const indexDir = path.join(home, 'indexes', 'v-00000000');
  const dataDir = path.join(indexDir, 'data-0001');
  const manifest = newManifest({ dataName: 'data-0001', vault: { name: 'v', path: '/nowhere', pathHash: '0' }, chunker: { version: 1, settingsHash: 'x', budgetTokens: 10, counter: 'fake' }, embedding: { model: 'fake', dimensions: DIMS }, engine: {} });
  manifest.sidecar.logBytes = createDataDir(dataDir, {});
  const side = openSidecar(dataDir, manifest.sidecar, DIMS);
  const notes = [['A.md', 2], ['B.md', 3]];
  const where = side.appendPuts(notes.map(([key, n], k) => ({ record: { v: 1, op: 'put', path: String(key), sha256: 's', size: 1, mtimeMs: 1, fip: false, title: 't', passages: Array.from({ length: Number(n) }, (_, i) => ({ n: i, trail: [], line: 1, text: 't', flags: [] })) }, vectors: Array.from({ length: Number(n) }, (_, i) => { const v = new Float32Array(DIMS); v[(k * 2 + i) % DIMS] = 1; return v; }) })));
  notes.forEach(([key, n], i) => { manifest.notes[String(key)] = { sha256: 's', size: 1, mtimeMs: 1, racy: false, passages: Number(n), folderInPrefix: false, log: where[i].log, vec: where[i].vec, flagged: 0 }; });
  manifest.sidecar.logBytes = side.logBytes; manifest.sidecar.vectors = side.vectors; side.close();
  saveManifest(dataDir, manifest); switchCurrent(indexDir, 'data-0001');
  const loaded = loadManifest(indexDir);
  const made = [];
  const deps = {
    native: () => true,
    create: async (/** @type {string} */ file) => { fs.writeFileSync(file, 'engine file'); const engine = memoryEngine(); made.push(engine); return { engine, storagePath: file }; },
    open: async () => ({ engine: made[made.length - 1] || memoryEngine(), storagePath: '' }),
    selfTest: async (/** @type {any} */ engine) => flatSelfTest(engine, DIMS, () => true),
  };
  return { home, indexDir, loaded, deps, made };
}

test('ids: split at the last #, built from the path and the passage number', () => {
  assert.deepEqual(parseId('Notes/C# tips.md#12'), { path: 'Notes/C# tips.md', n: 12 });
  assert.equal(passageId('A.md', 0), 'A.md#0');
  const s = setup();
  assert.deepEqual(idTable(s.loaded.manifest), ['A.md#0', 'A.md#1', 'B.md#0', 'B.md#1', 'B.md#2']);
});

test('score: 1 - distance, kept within 0..1 (cosine distance can reach 2)', () => {
  assert.equal(similarity(0), 1);
  assert.equal(similarity(2), 0);
  assert.equal(similarity(-0.0000001), 1);
  assert.ok(Math.abs(similarity(0.38) - 0.62) < 1e-9);
});

test('a first build loads every row, checks the count before switching, and records the stamp', async () => {
  const s = setup();
  const r = await ensureEngine({ indexDir: s.indexDir, loaded: s.loaded, dimensions: DIMS, deps: s.deps, quiet: true });
  assert.equal(r.how, 'rebuilt');
  assert.equal(await r.engine.count(), 5);
  assert.deepEqual(engineStamp(s.indexDir), { stamp: s.loaded.manifest.stamp, count: 5, file: 'index-0001.db' });
  assert.deepEqual(r.notices, []);
});

for (const [label, probe] of [
  ['is killed by a signal', { ok: false, count: 0, flat: false, reason: 'signal SIGABRT', ms: 3 }],
  ['exits non-zero', { ok: false, count: 0, flat: false, reason: 'exit 3', ms: 3 }],
  ['prints no number', { ok: false, count: 0, flat: false, reason: 'no number', ms: 3 }],
  ['times out', { ok: false, count: 0, flat: false, reason: 'timeout', ms: 20000 }],
]) {
  test(`a probe child that ${label} leads to a rebuilt file and the notice`, async () => {
    const s = setup();
    await ensureEngine({ indexDir: s.indexDir, loaded: s.loaded, dimensions: DIMS, deps: s.deps, quiet: true });
    let opened = 0;
    const r = await ensureEngine({ indexDir: s.indexDir, loaded: s.loaded, dimensions: DIMS, deps: { ...s.deps, probe: async () => /** @type {any} */ (probe), open: async () => { opened++; throw new Error('must not open a file the probe refused'); } } });
    assert.equal(r.how, 'damaged');
    assert.equal(opened, 0, 'this process never opens an existing file the probe refused');
    assert.match(r.notices[0], /^The index file was damaged\. It was rebuilt from saved passages \(\d+\.\d s\)\. Your notes were not touched\.$/);
    assert.equal(await r.engine.count(), 5);
    assert.equal(engineStamp(s.indexDir).file, 'index-0002.db');
    assert.ok(!fs.existsSync(path.join(s.indexDir, 'engine', 'index-0001.db')), 'the damaged file is thrown away');
  });
}

test('a healthy probe means the existing file is used; a stale stamp means a reload with one notice', async () => {
  const s = setup();
  await ensureEngine({ indexDir: s.indexDir, loaded: s.loaded, dimensions: DIMS, deps: s.deps, quiet: true });
  const ok = async () => ({ ok: true, count: 5, flat: true, reason: null, ms: 1 });
  const used = await ensureEngine({ indexDir: s.indexDir, loaded: s.loaded, dimensions: DIMS, deps: { ...s.deps, probe: ok } });
  assert.equal(used.how, 'used');
  const wrongCount = await ensureEngine({ indexDir: s.indexDir, loaded: s.loaded, dimensions: DIMS, deps: { ...s.deps, probe: async () => ({ ok: true, count: 4, flat: true, reason: null, ms: 1 }) } });
  assert.equal(wrongCount.how, 'rebuilt');
  const notFlat = await ensureEngine({ indexDir: s.indexDir, loaded: s.loaded, dimensions: DIMS, deps: { ...s.deps, probe: async () => ({ ok: true, count: 5, flat: false, reason: null, ms: 1 }) } });
  assert.equal(notFlat.how, 'rebuilt');
  saveManifest(s.loaded.dataDir, s.loaded.manifest); // the stamp moves on
  const stale = await ensureEngine({ indexDir: s.indexDir, loaded: s.loaded, dimensions: DIMS, deps: { ...s.deps, probe: ok } });
  assert.equal(stale.how, 'rebuilt');
  assert.match(stale.notices[0], /^The index was reloaded from saved passages \(\d+\.\d s\)\.$/);
});

test('a reader holding an older manifest brings the engine in step with the saved one, and says which it used', async () => {
  const s = setup();
  const reader = structuredClone(s.loaded); // a search loaded this, then waited for the index lock
  delete s.loaded.manifest.notes['A.md']; // meanwhile a sync removed a note and saved
  saveManifest(s.loaded.dataDir, s.loaded.manifest);
  await ensureEngine({ indexDir: s.indexDir, loaded: s.loaded, dimensions: DIMS, deps: s.deps, quiet: true });
  assert.equal(engineStamp(s.indexDir).stamp, s.loaded.manifest.stamp);
  assert.notEqual(reader.manifest.stamp, s.loaded.manifest.stamp);
  let built = 0;
  const r = await ensureEngine({ indexDir: s.indexDir, loaded: reader, dimensions: DIMS, deps: { ...s.deps, create: async (file) => { built++; return s.deps.create(file); }, probe: async () => ({ ok: true, count: 3, flat: true, reason: null, ms: 1 }) } });
  assert.equal(r.how, 'used', 'the engine the sync left is used as it is');
  assert.equal(built, 0, 'nothing is rebuilt from the older snapshot');
  assert.equal(engineStamp(s.indexDir).stamp, s.loaded.manifest.stamp, 'and the older stamp is never written back');
  assert.equal(r.loaded.manifest.stamp, s.loaded.manifest.stamp, 'the caller is handed the manifest the engine matches');
  assert.deepEqual(Object.keys(r.loaded.manifest.notes), ['B.md']);
});

test('the self-test fails closed on a missing null config and on a duplicated id', async () => {
  const notFlat = (/** @type {any} */ e) => e.code === 'VM_E_ENGINE_NOT_FLAT';
  await flatSelfTest(memoryEngine(), DIMS, () => true);
  await assert.rejects(flatSelfTest(memoryEngine(), DIMS, () => false), notFlat, 'the file does not say it is flat');
  await assert.rejects(flatSelfTest(memoryEngine('duplicates'), DIMS, () => true), notFlat, 'one id came back twice');
  await assert.rejects(flatSelfTest(memoryEngine('tombstones'), DIMS, () => true), notFlat, 'a delete that does not delete');
  const stale = memoryEngine(); const realInsert = stale.insert; let first = true;
  stale.insert = async (/** @type {any[]} */ rows) => { if (first) { first = false; return realInsert(rows); } }; // keeps the old vector
  await assert.rejects(flatSelfTest(stale, DIMS, () => true), notFlat, 'a replaced vector was still the one found');
});

test('a new file that fails its self-test is removed and never used; the exact engine serves the search', async () => {
  const s = setup();
  const r = await ensureEngine({ indexDir: s.indexDir, loaded: s.loaded, dimensions: DIMS, deps: { ...s.deps, create: async (file) => { fs.writeFileSync(file, 'x'); return { engine: memoryEngine('duplicates'), storagePath: file }; } } });
  assert.equal(r.how, 'exact');
  assert.equal(r.engine.name, 'exact');
  assert.deepEqual(r.warnings, ['VM_E_ENGINE_NOT_FLAT']);
  assert.equal(engineStamp(s.indexDir), null);
  assert.deepEqual(fs.readdirSync(path.join(s.indexDir, 'engine')), []);
  const q = new Float32Array(DIMS); q[2] = 1;
  assert.equal((await r.engine.search(q, 1))[0].id, 'B.md#0');
  const noNative = await ensureEngine({ indexDir: s.indexDir, loaded: s.loaded, dimensions: DIMS, deps: { ...s.deps, native: () => false } });
  assert.equal(noNative.how, 'exact');
  assert.equal(noNative.notices.length, 1, 'announced in one line');
});

test('where the open file cannot be read (Windows), the answer read before it was opened decides the self-test', async () => {
  // The create step reports `flat` itself. The self-test must use that answer and must not try to read the file.
  const seen = [];
  const run = async (/** @type {boolean} */ flat) => {
    const s = setup();
    return ensureEngine({ indexDir: s.indexDir, loaded: s.loaded, dimensions: DIMS, deps: { ...s.deps,
      create: async (file) => ({ engine: memoryEngine(), storagePath: file, flat }),
      selfTest: async (_engine, _dims, check) => { seen.push(typeof check === 'function' ? check() : check); if (typeof check === 'function' && !check()) throw Object.assign(new Error('not flat'), { code: 'VM_E_ENGINE_NOT_FLAT' }); } } });
  };
  assert.notEqual((await run(true)).how, 'exact', 'a file read as flat is used');
  const no = await run(false);
  assert.equal(no.how, 'exact'); assert.deepEqual(no.warnings, ['VM_E_ENGINE_NOT_FLAT']);
  assert.deepEqual(seen, [true, false], 'the self-test was handed the answer, not a path to read');
});

test('applying just the changed notes when the engine sits at the previous stamp', async () => {
  const s = setup();
  await ensureEngine({ indexDir: s.indexDir, loaded: s.loaded, dimensions: DIMS, deps: s.deps, quiet: true });
  const fromStamp = s.loaded.manifest.stamp;
  delete s.loaded.manifest.notes['A.md'];
  saveManifest(s.loaded.dataDir, s.loaded.manifest);
  const r = await ensureEngine({ indexDir: s.indexDir, loaded: s.loaded, dimensions: DIMS, quiet: true, delta: { fromStamp, removeIds: ['A.md#0', 'A.md#1'], addRows: [] }, deps: { ...s.deps, probe: async () => ({ ok: true, count: 5, flat: true, reason: null, ms: 1 }) } });
  assert.equal(r.how, 'applied');
  assert.equal(await r.engine.count(), 3);
  assert.equal(engineStamp(s.indexDir).stamp, s.loaded.manifest.stamp);
});

test('the probe reports a child that dies, fails, prints nothing or hangs', async () => {
  const fake = (/** @type {(child: any) => void} */ act) => /** @type {any} */ (() => { const c = new EventEmitter(); /** @type {any} */ (c).stdout = new EventEmitter(); /** @type {any} */ (c).kill = () => {}; setTimeout(() => act(c), 5); return c; });
  assert.equal((await probeEngineFile('f', DIMS, { spawnFn: fake((c) => c.emit('close', null, 'SIGABRT')) })).reason, 'signal SIGABRT');
  assert.equal((await probeEngineFile('f', DIMS, { spawnFn: fake((c) => c.emit('close', 3, null)) })).reason, 'exit 3');
  assert.equal((await probeEngineFile('f', DIMS, { spawnFn: fake((c) => c.emit('close', 0, null)) })).reason, 'no number');
  assert.equal((await probeEngineFile('f', DIMS, { spawnFn: fake((c) => { c.stdout.emit('data', 'not json\n'); c.emit('close', 0, null); }) })).reason, 'no number');
  assert.equal((await probeEngineFile('f', DIMS, { timeoutMs: 30, spawnFn: fake(() => {}) })).reason, 'timeout');
  const ok = await probeEngineFile('f', DIMS, { spawnFn: fake((c) => { c.stdout.emit('data', '{"count":18400,"flat":true}\n'); c.emit('close', 0, null); }) });
  assert.deepEqual([ok.ok, ok.count, ok.flat], [true, 18400, true]);
});

test('the exact engine: a plain cosine scan that skips dead positions', async () => {
  const vectors = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0.9, 0.1, 0, 0, 0, 0, 5, 0]);
  const e = createExact(vectors, (i) => (i === 1 ? null : `p${i}`), DIMS);
  assert.equal(await e.count(), 3);
  assert.deepEqual((await e.search(Float32Array.from([1, 0, 0, 0]), 2)).map((h) => h.id), ['p0', 'p2']);
  assert.equal((await e.search(Float32Array.from([0, 0, 1, 0]), 1))[0].score, 1, 'vectors need not be unit length');
  await assert.rejects(e.insert([]), /takes no writes/);
});
