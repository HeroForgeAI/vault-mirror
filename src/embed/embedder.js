// @ts-check
// Builds an Embedder from the model table. The rest of the tool talks to this interface only.
import { setImmediate } from 'node:timers';
import { modelEntry } from './models.js';
import { modelFiles, readIdentity, loadCounter, isTested } from './model.js';
import { createPool, createStallWatch } from './pool.js';
import { hold, release } from './quiet.js';
import { VmError } from '../errors.js';
import { loadRuvector } from '../engine/ruvector-loader.js';

/**
 * @typedef {object} Embedder
 * @property {string} name
 * @property {number} dimensions
 * @property {number} windowTokens
 * @property {number} budgetTokens
 * @property {string} counterName
 * @property {boolean} modelPresent
 * @property {(known?: Partial<import('./model.js').Identity> | null) => import('./model.js').Identity} identity
 * @property {(opts?: { queries?: string[] }) => Promise<void>} init
 * @property {(text: string) => number} countTokens
 * @property {(texts: string[]) => Promise<(Float32Array | null)[]>} embedPassages
 * @property {(text: string) => Promise<Float32Array>} embedQuery
 * @property {(workers: number) => Promise<void>} startPool
 * @property {() => number} poolWorkers
 * @property {() => Promise<void>} shutdown
 * @property {() => boolean} tested
 */

/**
 * Why a vector may not be stored, or null when it is fine.
 * @param {ArrayLike<number> | null | undefined} vec
 * @param {number} dimensions
 */
export function vectorProblem(vec, dimensions) {
  if (!vec || vec.length !== dimensions) return 'wrong length';
  let anyNonZero = false;
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) return 'not finite';
    if (vec[i] !== 0) anyNonZero = true;
  }
  return anyNonZero ? null : 'all zero';
}

/**
 * @param {object} opts
 * @param {string} opts.model                          the key in models.js
 * @param {any} [opts.lib]                             the embedding library; tests pass a fake
 * @param {(line: string) => void} [opts.debug]        receives library chatter and events
 * @param {(line: string) => void} [opts.notice]       one-line notices for the person
 * @param {{ everyMs?: number, stallMs?: number }} [opts.watch]  the download watchdog's clock; tests shorten it
 * @returns {Embedder}
 */
export function createEmbedder(opts) {
  const entry = modelEntry(opts.model);
  const debug = opts.debug || (() => {});
  const notice = opts.notice || (() => {});
  /** @type {any} */
  let lib = opts.lib || null;
  /** @type {ReturnType<typeof loadCounter> | null} */
  let counter = null;
  /** @type {import('./model.js').Identity | null} */
  let id = null;
  let ready = false;
  /** @type {any} */
  let initError = null;
  /** @type {ReturnType<typeof createPool> | null} */
  let pool = null;
  let poolErrors = 0;
  let poolSize = 0;
  /** @type {ReturnType<typeof createStallWatch> | null} */
  let stall = null;

  /** Translate the library's raw errors. They are never shown. @param {any} e */
  function translate(e) {
    const text = String(e && e.message ? e.message : e);
    debug(`embedder error: ${text.slice(0, 200)}`);
    if (/fetch failed\s*$/.test(text)) return new VmError('VM_E_MODEL_OFFLINE');
    // The host answered, but not with the file (a web filter's 403, a 429, a 503): "Failed to fetch <url>: 503 <status text>".
    if (/Failed to fetch \S+: \d{3}( |$)/.test(text)) return new VmError('VM_E_MODEL_OFFLINE');
    if (/undefined\s*$/.test(text)) return new VmError('VM_E_MODEL_BROKEN', { path: modelFiles(entry).dir });
    return e;
  }

  /**
   * Let the library download while a watchdog counts the bytes that arrive. The library keeps the whole
   * file in memory and writes it to disk in one call at the end, so the model folder stays empty for the
   * whole transfer: a slow download can only be told from a stalled one on the network side. The
   * library's requests are counted on their way through `fetch`; nothing about them is changed.
   */
  async function initWithWatchdog(/** @type {number} */ maxLength) {
    const files = modelFiles(entry);
    if (files.modelStat && files.tokenizerStat) { await lib.initOnnxEmbedder({ maxLength }); return; }
    notice(`Downloading the reading model once (about ${entry.downloadMB} MB). After this, everything runs on your computer.`);
    const everyMs = opts.watch?.everyMs ?? 5000; const stallMs = opts.watch?.stallMs ?? 60000;
    const realFetch = globalThis.fetch;
    let received = 0; let inFlight = 0;
    if (typeof realFetch === 'function') {
      globalThis.fetch = /** @type {typeof fetch} */ (async (input, init) => {
        inFlight++;
        /** @type {Response} */
        let res;
        try { res = await realFetch(input, init); } catch (e) { inFlight--; throw e; }
        if (!res.body) { inFlight--; return res; }
        const counted = res.body.pipeThrough(new TransformStream({
          transform(chunk, controller) { received += chunk.byteLength; controller.enqueue(chunk); },
          flush() { inFlight--; },
        }));
        return new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
      });
    }
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    let shownMB = 0; let lastBytes = 0; let lastGrowth = Date.now(); let told = false; let lastLook = Date.now();
    /** @type {Promise<never>} */
    const stalled = new Promise((_, reject) => {
      timer = setInterval(() => {
        // A look that comes late means this process was not running (held up, or the laptop slept).
        // That time says nothing about the network, so it is not counted as silence.
        const late = Date.now() - lastLook - everyMs; lastLook = Date.now();
        if (late > everyMs) lastGrowth += late;
        const quiet = Date.now() - lastGrowth;
        if (received > lastBytes) {
          lastBytes = received; lastGrowth = Date.now(); told = false;
          const mb = Math.floor(received / 1e6);
          if (mb >= shownMB + 10) { shownMB = mb; notice(`Downloaded ${mb} MB so far.`); } // a line every 10 MB: a handful in all
        } else if (inFlight === 0) lastGrowth = Date.now(); // nothing is on its way: the library is saving or loading the file
        else if (quiet > stallMs) reject(new VmError('VM_E_MODEL_OFFLINE'));
        else if (!told && quiet >= stallMs / 3) { told = true; notice(`No data has arrived for ${Math.round(quiet / 1000)} s. Still waiting; this stops by itself at ${Math.round(stallMs / 1000)} s.`); }
      }, everyMs);
    });
    try {
      const work = Promise.resolve(lib.initOnnxEmbedder({ maxLength }));
      work.catch(() => {}); // if the watchdog gives up first, a later failure of the abandoned download has nowhere to go
      await Promise.race([work, stalled]);
    } finally {
      clearInterval(timer);
      if (typeof realFetch === 'function') globalThis.fetch = realFetch;
    }
  }

  /** @type {Embedder} */
  const embedder = {
    name: entry.name,
    dimensions: entry.dimensions,
    windowTokens: entry.windowTokens,
    budgetTokens: entry.budgetTokens,
    counterName: entry.counter,
    get modelPresent() { const f = modelFiles(entry); return Boolean(f.modelStat && f.tokenizerStat); },

    identity(known) {
      if (!id) id = readIdentity(entry, known);
      return id;
    },

    tested() { return isTested(entry, embedder.identity()); },

    async init(o = {}) {
      if (ready) return;
      if (initError) throw initError; // the library caches a failed init; a second try cannot succeed
      hold(debug);
      try {
        if (!lib) lib = loadRuvector();
        let maxLength = entry.maxLength;
        if (o.queries && o.queries.length && embedder.modelPresent) {
          // A question is short. A smaller padding gives the same vector for less work.
          const longest = Math.max(...o.queries.map((q) => embedder.countTokens(entry.queryLead + q)));
          for (const pad of [16, 32, 64]) if (longest + 2 <= pad && pad < maxLength) { maxLength = pad; break; }
        }
        await initWithWatchdog(maxLength);
        id = null;
        const now = embedder.identity(); // hash check of both files before first use
        if (now.modelSize < 1024 * 1024) throw new VmError('VM_E_MODEL_BROKEN', { path: modelFiles(entry).dir });
        ready = true;
      } catch (e) {
        initError = translate(e);
        release();
        throw initError;
      }
    },

    countTokens(text) {
      if (!counter) counter = loadCounter(entry);
      return counter.count(text);
    },

    async startPool(workers) {
      if (!ready) await embedder.init();
      if (workers < 1 || pool) return;
      poolSize = workers;
      pool = createPool(lib, workers);
      stall = createStallWatch();
      await pool.start();
    },

    poolWorkers() { return pool && pool.running ? poolSize : 0; },

    async embedPassages(texts) {
      if (!ready) await embedder.init();
      const leadTexts = entry.passageLead ? texts.map((t) => entry.passageLead + t) : texts;
      /** @type {ArrayLike<number>[] | null} */
      let raw = null;
      if (pool && pool.running) {
        for (let attempt = 0; attempt < 2 && !raw && pool; attempt++) {
          try { raw = await pool.embed(leadTexts); }
          catch (e) {
            // Never keep using a pool after an error: a late reply could pair a vector with the wrong text.
            const afterStall = stall ? stall.recentlyStalled() : false;
            debug(`pool error (${afterStall ? 'after a stall, not counted' : 'counted'}): ${String(/** @type {any} */ (e)?.message).slice(0, 160)}`);
            await pool.stop();
            if (!afterStall) poolErrors++;
            if (poolErrors >= 2) { pool = null; notice('The readers had trouble twice. Finishing with one reader.'); }
            else { pool = createPool(lib, poolSize); await pool.start(); }
          }
        }
      }
      if (!raw) {
        raw = [];
        for (const t of leadTexts) {
          raw.push((await lib.embed(t)).embedding);
          // One reader works on this thread and never waits. Let the system in after each passage,
          // so a Ctrl+C or a timer is noticed now and not when the whole sync is over.
          await new Promise((r) => setImmediate(r));
        }
      }
      /** @type {(Float32Array | null)[]} */
      const out = [];
      for (let i = 0; i < leadTexts.length; i++) {
        let vec = raw[i];
        if (vectorProblem(vec, entry.dimensions)) {
          debug(`vector rejected (${vectorProblem(vec, entry.dimensions)}); trying once more with one reader`);
          try { vec = (await lib.embed(leadTexts[i])).embedding; } catch { vec = /** @type {any} */ (null); }
        }
        out.push(vectorProblem(vec, entry.dimensions) ? null : Float32Array.from(/** @type {ArrayLike<number>} */ (vec)));
      }
      return out;
    },

    async embedQuery(text) {
      if (!ready) await embedder.init({ queries: [text] });
      const vec = (await lib.embedQuery(entry.queryLead + text)).embedding;
      const problem = vectorProblem(vec, entry.dimensions);
      if (problem) throw new Error(`question vector ${problem}`);
      return Float32Array.from(vec);
    },

    async shutdown() {
      const p = pool; pool = null;
      if (stall) { stall.stop(); stall = null; }
      try { if (p) await p.stop(); } finally { release(); }
    },
  };
  return embedder;
}

/**
 * Run work with an embedder and always shut it down afterwards: on success, on any thrown
 * error and on a safety stop. A pool left running would keep the command from ever returning.
 * @template T
 * @param {Embedder} embedder
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withEmbedder(embedder, work) {
  try { return await work(); } finally { await embedder.shutdown(); }
}
