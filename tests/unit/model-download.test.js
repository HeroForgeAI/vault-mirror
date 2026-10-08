import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEmbedder } from '../../src/embed/embedder.js';
import { modelFiles } from '../../src/embed/model.js';
import { modelEntry, DEFAULT_MODEL } from '../../src/embed/models.js';
import { VmError } from '../../src/errors.js';
import { tmpDir, tinyTokenizer } from '../helpers/tmp.mjs';

// The first run on a computer: no reading model in the cache yet. The library is a stand-in that does
// what the real one does: it asks `fetch` for the file, keeps the whole answer in memory, and writes
// the model folder in one go only when every byte has arrived. No network is used.
const entry = modelEntry(DEFAULT_MODEL);
const WATCH = { everyMs: 20, stallMs: 400 }; // the real clock is 5 s and 60 s
const PIECE = 2 * 1024 * 1024;
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @param {typeof fetch} fakeFetch @param {(e: ReturnType<typeof createEmbedder>, notices: string[]) => Promise<void>} run @param {number} [savingMs] */
async function firstRun(fakeFetch, run, savingMs = 0) {
  await sleep(5); // the embedder holds stdout while it starts; let the test reporter print the previous result first
  process.env.RUVECTOR_CACHE_DIR = tmpDir('empty-cache');
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  const lib = {
    async initOnnxEmbedder() {
      const res = await fetch('https://model-host.invalid/model.onnx');
      if (!res.ok) throw new Error(`Failed to initialize ONNX embedder: Failed to fetch https://model-host.invalid/model.onnx: ${res.status} ${res.statusText}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      await sleep(savingMs); // saving the file and loading it into the model
      const files = modelFiles(entry);
      fs.mkdirSync(files.dir, { recursive: true });
      fs.writeFileSync(files.model, bytes);
      fs.writeFileSync(files.tokenizer, JSON.stringify(tinyTokenizer()));
    },
    async shutdown() {},
  };
  /** @type {string[]} */
  const notices = [];
  const e = createEmbedder({ model: DEFAULT_MODEL, lib, notice: (l) => notices.push(l), watch: WATCH });
  try {
    await run(e, notices);
    assert.equal(globalThis.fetch, fakeFetch, 'the library\'s fetch is put back as it was');
  } finally { await e.shutdown(); globalThis.fetch = realFetch; }
}

/** A body of `chunks` two-megabyte pieces, one every `gapMs`. It never ends when `thenHang` is set. */
function slowBody(/** @type {number} */ chunks, /** @type {number} */ gapMs, thenHang = false, /** @type {number[]} */ sentAt = []) {
  let sent = 0;
  return new ReadableStream({
    async pull(controller) {
      if (sent === chunks) { if (thenHang) await new Promise(() => {}); controller.close(); return; }
      await sleep(gapMs);
      controller.enqueue(new Uint8Array(PIECE)); sent++; sentAt.push(Date.now());
    },
  });
}

test('a slow download that keeps arriving is never stopped, and says how far it is', async () => {
  // Twelve pieces, 100 ms apart: the transfer takes three times the stall limit, and the model
  // folder stays empty until its very end.
  /** @type {number[]} */
  const sentAt = [];
  await firstRun(async () => new Response(slowBody(12, 100, false, sentAt)), async (e, notices) => {
    assert.equal(e.modelPresent, false);
    // When this fails, say what the clock saw: when each piece left, and the longest the process went without running a timer.
    const started = Date.now(); let lastTick = started; let longestGap = 0;
    const watchFolder = setInterval(() => { longestGap = Math.max(longestGap, Date.now() - lastTick); lastTick = Date.now(); if (!e.modelPresent) assert.ok(!fs.existsSync(modelFiles(entry).model)); }, 20);
    try { await e.init(); } catch (err) { /** @type {any} */ (err).message += ` [pieces left at ${sentAt.map((t) => t - started).join(', ')} ms; stopped at ${Date.now() - started} ms; longest gap between 20 ms ticks ${longestGap} ms; notices ${JSON.stringify(notices)}]`; throw err; } finally { clearInterval(watchFolder); }
    assert.equal(e.modelPresent, true);
    assert.equal(fs.statSync(modelFiles(entry).model).size, 12 * PIECE, 'every byte reached the library unchanged');
    assert.match(notices[0], /^Downloading the reading model once \(about \d+ MB\)\./);
    const progress = notices.filter((l) => /^Downloaded \d+ MB so far\.$/.test(l));
    assert.deepEqual(progress.map((l) => Number(/\d+/.exec(l))).map((mb) => mb >= 10), [true, true], `a line about every 10 MB: ${JSON.stringify(notices)}`);
  });
});

test('time when this process was not running (a frozen process, a laptop asleep) is not counted as a stalled download', async () => {
  // The first piece is due at 300 ms. The process is held from 30 ms for one and a half stall limits, so the
  // watchdog's next look comes late, with nothing received yet. That silence was ours, not the network's.
  await firstRun(async () => new Response(slowBody(4, 300)), async (e) => {
    setTimeout(() => { const end = Date.now() + WATCH.stallMs * 1.5; while (Date.now() < end) { /* hold the process */ } }, 30);
    await e.init();
    assert.equal(e.modelPresent, true);
  });
});

test('a download where nothing ever arrives says it is still waiting, then stops as offline', async () => {
  await firstRun(() => new Promise(() => {}), async (e, notices) => {
    const started = Date.now();
    await assert.rejects(e.init(), (err) => err instanceof VmError && err.code === 'VM_E_MODEL_OFFLINE' && err.exitCode === 5);
    assert.ok(Date.now() - started >= WATCH.stallMs, 'not before the stall limit');
    assert.equal(notices.filter((l) => /^No data has arrived for \d+ s\. Still waiting; this stops by itself at \d+ s\.$/.test(l)).length, 1, `one line during the wait: ${JSON.stringify(notices)}`);
  });
});

test('a download that starts and then stops moving also stops as offline', async () => {
  await firstRun(async () => new Response(slowBody(3, 10, true)), async (e) => {
    await assert.rejects(e.init(), (err) => err instanceof VmError && err.code === 'VM_E_MODEL_OFFLINE');
    assert.ok(!fs.existsSync(modelFiles(entry).model), 'nothing half-downloaded is left as the model');
  });
});

test('slow work after the last byte (saving and loading the file) is not taken for a stalled download', async () => {
  await firstRun(async () => new Response(slowBody(3, 5)), async (e) => {
    await e.init();
    assert.equal(e.modelPresent, true);
  }, WATCH.stallMs * 3);
});

for (const status of [403, 429, 503]) {
  test(`the model host answering ${status} is the offline error, not an internal one`, async () => {
    await firstRun(async () => new Response('refused', { status, statusText: 'Refused' }), async (e) => {
      await assert.rejects(e.init(), (err) => err instanceof VmError && err.code === 'VM_E_MODEL_OFFLINE' && /Connect to the internet and run `vault-mirror doctor`/.test(err.next));
      assert.ok(!fs.existsSync(modelFiles(entry).dir), 'no model folder is made, so nothing tells the person to delete one');
    });
  });
}
