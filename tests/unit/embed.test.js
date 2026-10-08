import test, { beforeEach } from 'node:test';
import { setImmediate } from 'node:timers';
import assert from 'node:assert/strict';
import { createEmbedder, withEmbedder, vectorProblem } from '../../src/embed/embedder.js';
import { createPool } from '../../src/embed/pool.js';
import { hold, release, writeOut, isHeld } from '../../src/embed/quiet.js';
import { VmError } from '../../src/errors.js';
import fs from 'node:fs';
import { modelFiles } from '../../src/embed/model.js';
import { modelEntry, DEFAULT_MODEL } from '../../src/embed/models.js';
import { tmpDir, tinyTokenizer } from '../helpers/tmp.mjs';

// No model, no engine. Before first use the embedder checks the model's two files on disk, even
// when the library is a fake, so these tests give it a stand-in model folder of their own.
// Without it they would pass only on a computer that already has the real model in its home folder.
process.env.RUVECTOR_CACHE_DIR = tmpDir('model');
const standIn = modelFiles(modelEntry(DEFAULT_MODEL));
fs.mkdirSync(standIn.dir, { recursive: true });
fs.writeFileSync(standIn.model, Buffer.alloc(1024 * 1024)); // the smallest size the embedder accepts as a finished download
fs.writeFileSync(standIn.tokenizer, JSON.stringify(tinyTokenizer()));

// The embedder holds stdout while it works; let the test reporter print the previous result first.
beforeEach(() => new Promise((r) => setTimeout(r, 5)));

const DIMS = createEmbedder({ model: DEFAULT_MODEL, lib: {} }).dimensions;
const good = (seed = 1) => Array.from({ length: DIMS }, (_, i) => Math.sin(seed + i));

/** A fake embedding library that records what was called. */
function fakeLib(over = {}) {
  const calls = { init: 0, pool: 0, shutdown: 0, embed: 0, batch: 0 };
  return {
    calls,
    async initOnnxEmbedder() { calls.init++; },
    async initParallelEmbedder() { calls.pool++; },
    async embedBatchParallel(/** @type {string[]} */ texts) { calls.batch++; return texts.map((_, i) => good(i)); },
    async embed() { calls.embed++; return { embedding: good(7) }; },
    async embedQuery() { return { embedding: good(9) }; },
    async shutdown() { calls.shutdown++; },
    ...over,
  };
}

test('shutdown runs after success and after a thrown error', async () => {
  const lib = fakeLib();
  const e = createEmbedder({ model: 'all-MiniLM-L6-v2', lib });
  await withEmbedder(e, async () => { await e.startPool(2); await e.embedPassages(['a', 'b']); });
  assert.equal(lib.calls.shutdown, 1);
  assert.equal(isHeld(), false, 'the output hold is released');
  const lib2 = fakeLib();
  const e2 = createEmbedder({ model: 'all-MiniLM-L6-v2', lib: lib2 });
  await assert.rejects(withEmbedder(e2, async () => { await e2.startPool(2); throw new VmError('VM_E_MASS_DELETE', { count: 12 }); }), /12 notes/);
  assert.equal(lib2.calls.shutdown, 1, 'also after a safety stop');
  await e2.shutdown();
  assert.equal(lib2.calls.shutdown, 1, 'safe to call twice');
});

test('with one reader, the process still notices a signal or a timer between passages', async () => {
  // One reader works on the main thread. If it never lets the system in, a Ctrl+C waits until the whole sync is over.
  const e = createEmbedder({ model: 'all-MiniLM-L6-v2', lib: fakeLib() });
  let stop = false; let done = 0;
  await withEmbedder(e, async () => {
    await e.embedPassages(['x']);
    setImmediate(() => { stop = true; }); // stands in for the signal: both wait for the same turn of the event loop
    for (; done < 1000 && !stop; done++) await e.embedPassages(['x', 'y']);
  });
  assert.equal(stop, true);
  assert.ok(done < 5, `noticed after ${done} of 1000 batches`);
});

// Windows has no SIGHUP that one process can send to another (process.kill fails with ENOSYS), so there is nothing to send.
test('shutdown runs when a signal asks the work to stop', { skip: process.platform === 'win32' ? 'Windows cannot send this signal to a process' : false }, async () => {
  const lib = fakeLib();
  const e = createEmbedder({ model: 'all-MiniLM-L6-v2', lib });
  let stop = false;
  const onSignal = () => { stop = true; };
  process.once('SIGHUP', onSignal);
  const done = withEmbedder(e, async () => {
    await e.startPool(2);
    for (let i = 0; i < 1000 && !stop; i++) { await e.embedPassages(['x']); if (i === 2) process.kill(process.pid, 'SIGHUP'); await new Promise((r) => setTimeout(r, 2)); }
    return 'checkpointed';
  });
  assert.equal(await done, 'checkpointed');
  assert.equal(stop, true);
  assert.equal(lib.calls.shutdown, 1);
});

test('an init failure ends the run and is not retried', async () => {
  let tries = 0;
  const lib = fakeLib({ async initOnnxEmbedder() { tries++; throw new Error('Failed to initialize ONNX embedder: fetch failed'); } });
  const e = createEmbedder({ model: 'all-MiniLM-L6-v2', lib });
  await assert.rejects(e.init(), (err) => err instanceof VmError && err.code === 'VM_E_MODEL_OFFLINE');
  await assert.rejects(e.init(), (err) => err instanceof VmError && err.code === 'VM_E_MODEL_OFFLINE');
  assert.equal(tries, 1, 'the library caches a failed init; a second try cannot succeed');
  assert.equal(isHeld(), false);
  // The library's own sentence when the model host answers with an error status (a web filter, a busy server).
  const refused = createEmbedder({ model: 'all-MiniLM-L6-v2', lib: fakeLib({ async initOnnxEmbedder() { throw new Error('Failed to initialize ONNX embedder: Failed to fetch https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx: 503 '); } }) });
  await assert.rejects(refused.init(), (err) => err instanceof VmError && err.code === 'VM_E_MODEL_OFFLINE');
  const broken = createEmbedder({ model: 'all-MiniLM-L6-v2', lib: fakeLib({ async initOnnxEmbedder() { throw new Error('Failed to initialize ONNX embedder: undefined'); } }) });
  await assert.rejects(broken.init(), (err) => err instanceof VmError && err.code === 'VM_E_MODEL_BROKEN' && /Delete the folder/.test(err.next));
});

test('a vector that is short, not finite or all zero is rejected', async () => {
  assert.equal(vectorProblem(good(), DIMS), null);
  assert.equal(vectorProblem(good().slice(1), DIMS), 'wrong length');
  assert.equal(vectorProblem(good().map((x, i) => (i === 5 ? NaN : x)), DIMS), 'not finite');
  assert.equal(vectorProblem(good().map((x, i) => (i === 5 ? Infinity : x)), DIMS), 'not finite');
  assert.equal(vectorProblem(new Array(DIMS).fill(0), DIMS), 'all zero');
  assert.equal(vectorProblem(null, DIMS), 'wrong length');
  // A bad vector from the pool is embedded once more single-threaded; if that is bad too, the slot is null.
  let single = 0;
  const lib = fakeLib({
    async embedBatchParallel(/** @type {string[]} */ texts) { return texts.map((_, i) => (i === 1 ? new Array(DIMS).fill(0) : i === 2 ? good().slice(3) : good(i))); },
    async embed(/** @type {string} */ text) { single++; return { embedding: text === 'c' ? new Array(DIMS).fill(0) : good(3) }; },
  });
  const e = createEmbedder({ model: 'all-MiniLM-L6-v2', lib });
  await e.startPool(2);
  const out = await e.embedPassages(['a', 'b', 'c']);
  await e.shutdown();
  assert.ok(out[0] instanceof Float32Array && out[1] instanceof Float32Array);
  assert.equal(out[2], null);
  assert.equal(single, 2);
});

test('a pool error discards the pool; a second one finishes with one reader', async () => {
  let fails = 2;
  const lib = fakeLib({ async embedBatchParallel(/** @type {string[]} */ texts) { if (fails-- > 0) throw new Error('embed request timed out after 30000ms'); return texts.map((_, i) => good(i)); } });
  const notices = [];
  const e = createEmbedder({ model: 'all-MiniLM-L6-v2', lib, notice: (l) => notices.push(l) });
  await e.startPool(2);
  const out = await e.embedPassages(['a', 'b']);
  assert.equal(out.length, 2);
  assert.ok(out.every((v) => v instanceof Float32Array));
  assert.equal(lib.calls.embed, 2, 'after two pool errors the group is read with one reader');
  assert.equal(e.poolWorkers(), 0);
  assert.ok(lib.calls.shutdown >= 2, 'each failed pool was shut down');
  assert.equal(notices.length, 1);
  await e.shutdown();
});

test('library output goes to the debug log, not to stdout or stderr', async () => {
  const lines = [];
  const lib = fakeLib({ async initOnnxEmbedder() { console.error('Loading ONNX model: chatter'); console.log('more chatter'); process.stderr.write('raw stderr chatter\n'); process.stdout.write('raw stdout chatter\n'); } });
  const e = createEmbedder({ model: 'all-MiniLM-L6-v2', lib, debug: (l) => lines.push(l) });
  const seen = [];
  const realOut = process.stdout.write; const realErr = process.stderr.write;
  await e.init();
  assert.ok(isHeld());
  assert.notEqual(process.stdout.write, realOut);
  await e.shutdown();
  assert.equal(process.stdout.write, realOut);
  assert.equal(process.stderr.write, realErr);
  assert.deepEqual(lines, ['Loading ONNX model: chatter', 'more chatter', 'raw stderr chatter', 'raw stdout chatter']);
  hold((l) => seen.push(l));
  console.log('x'.repeat(500));
  assert.equal(typeof writeOut, 'function', 'our own lines use the real writer');
  release();
  assert.equal(seen[0].length, 200, 'each line is cut at 200 characters');
});

test('a small job uses no pool, and the pool never starts with the library default', async () => {
  const lib = fakeLib();
  const e = createEmbedder({ model: 'all-MiniLM-L6-v2', lib });
  await e.embedPassages(['a', 'b', 'c']);
  assert.equal(lib.calls.pool, 0);
  assert.equal(lib.calls.embed, 3);
  await e.shutdown();
  const pool = createPool(lib, 0);
  await pool.start();
  assert.equal(pool.running, false);
  await pool.stop();
});
