// @ts-check
// What the server keeps between questions, and the search it runs with it.
// It holds the index's vectors and its exact-words table in memory and searches them with the
// built-in exact engine. It never opens the ruvector index file, so it holds no lock: a sync or a
// search from the command line is never kept waiting by a server that has been open all day. It
// writes nothing to the index, and it loads again by itself when a sync has changed what is saved.
import fs from 'node:fs';
import path from 'node:path';
import { loadManifest, currentDataName } from '../store/manifest.js';
import { readRecord } from '../store/sidecar.js';
import { liveOwner } from '../store/lock.js';
import { exactFromSidecar } from '../engine/build.js';
import { lookupVault } from '../vault/obsidian-registry.js';
import { searchReady, loadWords } from '../search/search.js';
import { planOnly } from '../sync/run.js';
import { readProgress } from '../sync/progress.js';
import { VmError } from '../errors.js';
import { plural } from '../cli/output.js';
import { leanSearch, wordCount } from './shape.js';
import { LIMIT_MAX } from './tools.js';

/** Changes whenever the saved index does: every save replaces manifest.json by a rename. @param {string} indexDir */
function mark(indexDir) {
  const name = currentDataName(indexDir);
  if (!name) return null;
  try { const s = fs.statSync(path.join(indexDir, name, 'manifest.json')); return `${name}:${s.ino}:${s.size}:${s.mtimeMs}`; } catch { return null; }
}

/**
 * @typedef {object} HeldIndex
 * @property {string} indexDir
 * @property {string | null} mark
 * @property {{ manifest: import('../store/manifest.js').Manifest, dataDir: string }} loaded
 * @property {number} dimensions
 * @property {import('../engine/engine.js').Engine} engine
 * @property {import('../words/table.js').WordsTable | null} words
 */

/**
 * @param {object} o
 * @param {import('./reader.js').Reader} o.reader
 * @param {(line: string) => void} [o.debug]
 */
export function createSession(o) {
  const debug = o.debug || (() => {});
  /** @type {HeldIndex | null} */
  let held = null;
  /** @type {Promise<any>} */
  let queue = Promise.resolve();

  /** The index as it is saved now: the one already in memory when nothing changed. @param {string} indexDir @returns {HeldIndex} */
  function load(indexDir) {
    for (let attempt = 0; ; attempt++) {
      const at = mark(indexDir); // taken before the read: a save that lands in between is seen by the next call
      if (held && held.indexDir === indexDir && at && held.mark === at) return held;
      const loaded = loadManifest(indexDir);
      if (!loaded || loaded.manifest.totals.passages === 0) {
        held = null;
        // A first sync that has saved nothing yet: "try again", not "nothing is set up".
        if (liveOwner(path.join(indexDir, 'sync.lock'))) throw new VmError('VM_E_BUSY', { percent: readProgress(indexDir)?.percent });
        throw new VmError('VM_E_NOT_SYNCED');
      }
      if (held && held.indexDir === indexDir && held.loaded.dataDir === loaded.dataDir && held.loaded.manifest.stamp === loaded.manifest.stamp) {
        held.mark = at; held.loaded = loaded; // same passages, newer bookkeeping
        return held;
      }
      try {
        const dimensions = Number(loaded.manifest.embedding.dimensions);
        held = { indexDir, mark: at, loaded, dimensions, engine: exactFromSidecar(loaded, dimensions), words: loadWords(indexDir, loaded, false) };
        debug(`mcp loaded the index passages=${loaded.manifest.totals.passages}`);
        return held;
      } catch (e) {
        // A sync's tidy rewrite replaced the data folder in the middle of the read: read CURRENT again, once.
        if (/** @type {any} */ (e)?.code !== 'ENOENT' || attempt > 0) throw e;
      }
    }
  }

  /**
   * How the index stands against the vault, without changing either. By size and date only.
   * @param {import('../sync/run.js').Context} ctx @param {import('../store/manifest.js').Manifest} manifest
   * @returns {Promise<{ notesWaiting: number | null, syncRunning: boolean, notice: string | null }>}
   */
  async function standing(ctx, manifest) {
    if (liveOwner(path.join(ctx.indexDir, 'sync.lock'))) {
      const p = readProgress(ctx.indexDir);
      return { notesWaiting: null, syncRunning: true, notice: `A sync is running${p ? ` (${p.percent}% done)` : ''}. This search covers what is saved so far.` };
    }
    try {
      const { plan } = await planOnly(ctx, { shallow: true, embedder: null, manifest });
      const n = plan.pending.new + plan.pending.changed + plan.pending.removed;
      if (n) return { notesWaiting: n, syncRunning: false, notice: `${plural(n, 'note')} ${n === 1 ? 'is' : 'are'} waiting to sync. This search covers what is indexed so far. Next: call sync_index.` };
      if (!manifest.lastRun || !manifest.lastRun.complete) return { notesWaiting: 0, syncRunning: false, notice: 'The last sync did not finish. This search covers what is indexed so far. Next: call sync_index.' };
      return { notesWaiting: 0, syncRunning: false, notice: null };
    } catch (e) {
      if (e instanceof VmError && e.exitCode === 4) return { notesWaiting: null, syncRunning: false, notice: `${e.message} This search covers what is indexed so far.` };
      debug(`mcp could not check the vault against the index: ${String(/** @type {any} */ (e)?.message).slice(0, 160)}`);
      return { notesWaiting: null, syncRunning: false, notice: null };
    }
  }

  /** Words in the passages handed back, and in the indexed text of the notes they came from. @param {HeldIndex} h @param {{ results: any[], exactWords: any[] }} found */
  function wordTotals(h, found) {
    try {
      const seen = new Set(); let inPassages = 0; let inTheirNotes = 0;
      for (const x of [...found.results, ...found.exactWords]) {
        inPassages += wordCount(x.text);
        if (seen.has(x.vaultPath)) continue;
        seen.add(x.vaultPath);
        for (const p of readRecord(h.loaded.dataDir, h.loaded.manifest.notes[x.vaultPath].log).passages) inTheirNotes += wordCount(p.text);
      }
      return { inPassages, inTheirNotes };
    } catch { return null; } // the counts are an extra; a search never fails for them
  }

  /**
   * @param {import('../sync/run.js').Context} ctx
   * @param {{ queries: string[], count?: number }} opts
   */
  async function searchNow(ctx, opts) {
    const t0 = performance.now();
    const v = /** @type {NonNullable<typeof ctx.cfg.vault>} */ (ctx.cfg.vault);
    const count = Math.max(1, Math.min(LIMIT_MAX, opts.count ?? v.resultCount));
    let h = load(ctx.indexDir);
    // The vault is compared with the index while the reader reads the question.
    const state = standing(ctx, h.loaded.manifest);
    const read = await o.reader.read(String(h.loaded.manifest.embedding.model), opts.queries);
    if (read.vectors.some((vec) => vec.length !== h.dimensions)) throw new VmError('VM_E_READER');
    const registry = lookupVault(ctx.vault.real);
    const run = (/** @type {HeldIndex} */ from) => {
      let next = 0;
      const embedder = /** @type {any} */ ({ embedQuery: async () => read.vectors[next++] }); // already read: one vector per wording, in order
      return searchReady({ embedder, engine: from.engine, manifest: from.loaded.manifest, dataDir: from.loaded.dataDir, words: from.words }, { queries: opts.queries, count, vaultPath: ctx.vault.real, vaultParam: registry.vaultParam });
    };
    /** @type {Awaited<ReturnType<typeof searchReady>>} */
    let found;
    try { found = await run(h); } catch (e) {
      if (/** @type {any} */ (e)?.code !== 'ENOENT') throw e;
      held = null; h = load(ctx.indexDir); found = await run(h); // the data folder was replaced under this search: once more on the new one
    }
    const st = await state;
    const notices = st.notice ? [st.notice] : [];
    if (registry.state !== 'registered' && !(registry.state === 'no-list' && registry.vaultParam)) notices.push('Open this folder as a vault in Obsidian once, and links will work. File paths work either way.');
    return leanSearch({
      vault: ctx.vault.name, found, totals: h.loaded.manifest.totals, state: st, words: wordTotals(h, found), notices,
      modelWasLoaded: read.wasLoaded, tookMs: Math.round(performance.now() - t0),
    });
  }

  return {
    /** One search at a time: they share one reader. @param {import('../sync/run.js').Context} ctx @param {{ queries: string[], count?: number }} opts */
    search(ctx, opts) {
      const run = queue.then(() => searchNow(ctx, opts));
      queue = run.catch(() => {});
      return run;
    },
    /** Forget what is in memory (the server is closing). */
    close() { held = null; },
  };
}
