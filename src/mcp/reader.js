// @ts-check
// The server's side of the reader. The reading model takes about 0.6 GB while it is loaded, and an
// MCP server lives as long as the app that started it. So the model is held by a child process:
// started by the first search, kept for the searches that follow, and stopped after a few idle
// minutes, which gives all of that memory back. Nothing is loaded until a search asks.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { QUESTION_PAD } from '../embed/models.js';
import { VmError } from '../errors.js';

const CHILD = fileURLToPath(new URL('./reader-child.js', import.meta.url));
const READY_MS = 10 * 60 * 1000; // a first run downloads the model; the download has its own stall watchdog
const ASK_MS = 60 * 1000;

/**
 * @typedef {object} Reader
 * @property {(model: string, queries: string[]) => Promise<{ vectors: Float32Array[], wasLoaded: boolean }>} read
 * @property {() => void} stop          stop the child now, if there is one
 * @property {() => number | null} pid  the child's process id, or null when the model is not loaded
 */

/**
 * @param {object} o
 * @param {number} o.idleMs                              how long the model stays loaded after the last search
 * @param {(line: string) => void} [o.debug]
 * @param {(line: string) => void} [o.notice]            one-line notices for the person (the one-time download)
 * @param {(model: string, pad: number) => import('node:child_process').ChildProcess} [o.start]   tests pass a stand-in
 * @param {{ readyMs?: number, askMs?: number }} [o.limits]
 * @returns {Reader}
 */
export function createReader(o) {
  const debug = o.debug || (() => {});
  const notice = o.notice || (() => {});
  const start = o.start || ((model, pad) => fork(CHILD, [model, String(pad)], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true }));
  const readyMs = o.limits?.readyMs ?? READY_MS; const askMs = o.limits?.askMs ?? ASK_MS;
  /** @typedef {{ proc: import('node:child_process').ChildProcess, model: string, pad: number, isReady: boolean, gone: boolean, ready: Promise<void>, waiting: Map<number, { resolve: (m: any) => void, reject: (e: any) => void }> }} Held */
  /** @type {Held | null} */
  let cur = null;
  let nextId = 1;
  /** @type {NodeJS.Timeout | undefined} */
  let idleTimer;

  /** @param {string} model @param {number} pad @returns {Held} */
  function open(model, pad) {
    const proc = start(model, pad);
    /** @type {{ resolve: () => void, reject: (e: any) => void }} */
    let settle = { resolve() {}, reject() {} };
    /** @type {Held} */
    const me = { proc, model, pad, isReady: false, gone: false, waiting: new Map(), ready: new Promise((resolve, reject) => { settle = { resolve, reject }; }) };
    me.ready.catch(() => {}); // read() awaits it; a child that dies with nobody waiting is not an unhandled rejection
    const fail = (/** @type {any} */ err) => {
      me.gone = true;
      if (cur === me) cur = null;
      settle.reject(err);
      for (const w of me.waiting.values()) w.reject(err);
      me.waiting.clear();
    };
    proc.on('message', (/** @type {any} */ m) => {
      if (!m || typeof m !== 'object') return;
      if (m.notice) return notice(String(m.notice));
      if (m.debug) return debug(String(m.debug));
      if (m.ready) { me.isReady = true; return settle.resolve(); }
      if (m.fatal) return fail(new VmError(String(m.fatal.code), m.fatal.params || {}));
      const w = me.waiting.get(m.id);
      if (!w) return;
      me.waiting.delete(m.id);
      if (m.error) w.reject(new VmError(String(m.error.code), m.error.params || {})); else w.resolve(m);
    });
    proc.on('error', () => fail(new VmError('VM_E_READER')));
    proc.on('exit', () => fail(new VmError('VM_E_READER')));
    debug(`mcp reader started pid=${proc.pid} padding=${pad || 'full'}`);
    return me;
  }

  /** @param {Held} me */
  function end(me) {
    if (cur === me) cur = null;
    if (me.gone) return;
    me.gone = true;
    debug(`mcp reader stopping pid=${me.proc.pid}`);
    try { me.proc.kill(); } catch { /* already gone */ }
  }

  /** @template T @param {Promise<T>} work @param {number} ms @param {Held} me @returns {Promise<T>} */
  function within(work, ms, me) {
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => { end(me); reject(new VmError('VM_E_READER')); }, ms); });
    return /** @type {Promise<T>} */ (Promise.race([work, late]).finally(() => clearTimeout(timer)));
  }

  /** @param {Held} me @param {string[]} queries */
  function ask(me, queries) {
    return within(new Promise((resolve, reject) => {
      const id = nextId++;
      me.waiting.set(id, { resolve, reject });
      try { me.proc.send({ id, queries }, (err) => { if (err) { me.waiting.delete(id); reject(new VmError('VM_E_READER')); } }); }
      catch { me.waiting.delete(id); reject(new VmError('VM_E_READER')); }
    }), askMs, me);
  }

  return {
    async read(model, queries) {
      clearTimeout(idleTimer);
      try {
        if (cur && cur.model !== model) end(cur);
        let wasLoaded = Boolean(cur && cur.isReady);
        let me = cur || (cur = open(model, QUESTION_PAD));
        await within(me.ready, readyMs, me);
        let reply = await ask(me, queries);
        if (reply.tooLong) {
          // A long question: read it with a reader started at the full length. That reader stays until it is idle.
          end(me);
          me = cur = open(model, 0);
          wasLoaded = false;
          await within(me.ready, readyMs, me);
          reply = await ask(me, queries);
        }
        if (!Array.isArray(reply.vectors) || reply.vectors.length !== queries.length) throw new VmError('VM_E_READER');
        return { vectors: reply.vectors.map((/** @type {ArrayLike<number>} */ v) => Float32Array.from(v)), wasLoaded };
      } finally {
        const me = cur;
        if (me) { idleTimer = setTimeout(() => end(me), o.idleMs); idleTimer.unref(); }
      }
    },
    stop() { clearTimeout(idleTimer); if (cur) end(cur); },
    pid() { return cur && !cur.gone && cur.proc.pid ? cur.proc.pid : null; },
  };
}
