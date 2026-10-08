// @ts-check
// Search: ask the index, return the best passage of each note with a way back to the note.
// One call gives two lists: the passages closest by meaning, and a short separate list of passages
// that hold the question's exact words.
import path from 'node:path';
import { loadManifest, withLiveData, fileOf } from '../store/manifest.js';
import { readRecord } from '../store/sidecar.js';
import { liveOwner } from '../store/lock.js';
import { ensureEngine } from '../engine/build.js';
import { parseId } from '../engine/engine.js';
import { createEmbedder } from '../embed/embedder.js';
import { lookupVault } from '../vault/obsidian-registry.js';
import { buildLink } from './link.js';
import { maskSecrets } from '../screen/screen.js';
import { runSync } from '../sync/run.js';
import { readProgress } from '../sync/progress.js';
import { VmError } from '../errors.js';
import { debug, runLine, setLogDir } from '../log.js';
import { plural } from '../cli/output.js';
import { wordsFor } from '../words/store.js';
import { exactWordHits, notAlreadyShown } from './exact-words.js';

/** At most `max` characters, whitespace collapsed, never cut inside a word. @param {string} text @param {number} [max] */
export function snippet(text, max = 400) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max + 1);
  const at = cut.lastIndexOf(' ');
  return (at > 0 ? cut.slice(0, at) : flat.slice(0, max)).trimEnd();
}

/**
 * Keep the best passage per note, across one or several phrasings of the question.
 * @param {import('../engine/engine.js').Hit[][]} hitLists   one list per phrasing
 * @param {(id: string) => boolean} known                    false for ids the manifest does not know
 * @returns {{ path: string, n: number, score: number, morePassages: number }[]}  best first
 */
export function collapse(hitLists, known) {
  /** @type {Map<string, { n: number, score: number, seen: Set<number> }>} */
  const byNote = new Map();
  for (const hits of hitLists) {
    for (const h of hits) {
      if (!known(h.id)) continue;
      const { path: p, n } = parseId(h.id);
      const cur = byNote.get(p);
      if (!cur) byNote.set(p, { n, score: h.score, seen: new Set([n]) });
      else { cur.seen.add(n); if (h.score > cur.score) { cur.score = h.score; cur.n = n; } }
    }
  }
  return [...byNote.entries()].map(([p, v]) => ({ path: p, n: v.n, score: v.score, morePassages: v.seen.size - 1 }))
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
}

/**
 * Fetch, collapse, and fetch four times as many once when one long note crowds the hits.
 * @param {import('../engine/engine.js').Engine} engine
 * @param {Float32Array[]} vectors
 * @param {number} count
 * @param {(id: string) => boolean} known
 */
export async function fetchNotes(engine, vectors, count, known) {
  let k = Math.max(count * 8, 50);
  for (let round = 0; ; round++) {
    const lists = [];
    let full = false;
    for (const v of vectors) { const hits = await engine.search(v, k); if (hits.length >= k) full = true; lists.push(hits); }
    const notes = collapse(lists, known);
    if (notes.length >= count || !full || round === 1) return notes.slice(0, count);
    k *= 4;
  }
}

/**
 * What a search that was told not to sync can still say. It never looks at the vault, but the index
 * records whether its last sync ran to the end: after a stopped or killed sync, part of the vault is missing.
 * @param {import('../store/manifest.js').Manifest} manifest
 * @returns {string | null}
 */
export function unfinishedNotice(manifest) {
  return manifest.lastRun && manifest.lastRun.complete ? null : 'The last sync did not finish. This search covers what is indexed so far. Next: vault-mirror sync --detach';
}

/**
 * The exact-words table for a manifest, or null when it cannot be had. A table that is behind is
 * brought in step from the saved passages, and saved unless a sync is running (the sync saves its own).
 * @param {string} indexDir @param {{ manifest: import('../store/manifest.js').Manifest, dataDir: string }} loaded @param {boolean} save
 */
export function loadWords(indexDir, loaded, save) {
  try { return wordsFor(indexDir, loaded, { save }).table; } catch (e) {
    if (/** @type {any} */ (e)?.code === 'ENOENT') throw e; // the data folder was replaced: the caller reads again
    debug(`the exact-words table could not be loaded: ${String(/** @type {any} */ (e)?.message).slice(0, 160)}`);
    return null;
  }
}

/**
 * @typedef {object} ReadyIndex   everything a search needs, already loaded
 * @property {import('../embed/embedder.js').Embedder} embedder   a ready embedder
 * @property {import('../engine/engine.js').Engine} engine         an open engine, in step with the manifest
 * @property {import('../store/manifest.js').Manifest} manifest
 * @property {string} dataDir                                      the data folder that manifest describes
 * @property {import('../words/table.js').WordsTable | null} words  the exact-words table for that manifest, or null to leave that list out
 */

/**
 * The search itself: the one path from a question to its results. It takes a ready embedder and a
 * ready index, loads nothing and writes nothing, so a process that keeps both in memory can call it
 * again and again.
 * @param {ReadyIndex} ready
 * @param {{ queries: string[], count: number, vaultPath: string, vaultParam: string | null }} opts
 */
export async function searchReady(ready, opts) {
  const { embedder, engine, manifest, dataDir, words } = ready;
  const timings = { embedMs: 0, searchMs: 0, wordsMs: 0, readMs: 0 };
  let t = performance.now();
  /** @type {Float32Array[]} */
  const vectors = [];
  for (const q of opts.queries) vectors.push(await embedder.embedQuery(q));
  timings.embedMs = Math.round(performance.now() - t);

  t = performance.now();
  const known = (/** @type {string} */ id) => { const { path: p, n } = parseId(id); const e = manifest.notes[p]; return Boolean(e) && n >= 0 && n < e.passages; };
  const notes = await fetchNotes(engine, vectors, opts.count, known);
  timings.searchMs = Math.round(performance.now() - t);

  /** @type {Map<string, import('../store/sidecar.js').PutRecord>} */
  const records = new Map();
  const record = (/** @type {string} */ notePath) => { let r = records.get(notePath); if (!r) { r = readRecord(dataDir, manifest.notes[notePath].log); records.set(notePath, r); } return r; };
  const shape = (/** @type {string} */ notePath, /** @type {number} */ n) => {
    const p = record(notePath).passages[n];
    const text = maskSecrets(p.text);
    return {
      note: (notePath.split('/').pop() || '').replace(/\.md$/i, ''),
      section: p.trail.join(' > '),
      path: path.join(opts.vaultPath, ...fileOf(notePath, manifest.notes[notePath]).split('/')),
      vaultPath: notePath,
      line: p.line,
      link: buildLink({ vaultParam: opts.vaultParam, vaultPath: notePath, heads: p.heads || [], repeats: Boolean(p.rep), recovered: Boolean(p.recovered) }),
      snippet: snippet(text),
      text,
      passage: `${notePath}#${n}`,
      flags: p.flags || [],
    };
  };

  // The exact-words list. It never fails a search: without it, the list by meaning still stands.
  t = performance.now();
  /** @type {{ notePath: string, n: number, score: number, words: string[] }[]} */
  let wordHits = [];
  if (words) {
    const names = Object.keys(manifest.notes);
    try { wordHits = exactWordHits(words, (i) => record(names[i]), opts.queries).map((h) => ({ notePath: names[h.note], n: h.n, score: h.score, words: h.words })); }
    catch (e) {
      if (/** @type {any} */ (e)?.code === 'ENOENT') throw e; // the data folder was replaced: the caller reads again
      debug(`the exact-words list was left out: ${String(/** @type {any} */ (e)?.message).slice(0, 160)}`);
    }
  }
  timings.wordsMs = Math.round(performance.now() - t);

  t = performance.now();
  const results = notes.map((hit, i) => {
    const { note, section, path: abs, vaultPath, line, link, snippet: snip, text, passage, flags } = shape(hit.path, hit.n);
    return { rank: i + 1, score: Math.round(hit.score * 1000) / 1000, note, section, path: abs, vaultPath, line, link, snippet: snip, text, passage, morePassages: hit.morePassages, flags };
  });
  const exactWords = notAlreadyShown(wordHits.map((h) => ({ passage: `${h.notePath}#${h.n}`, hit: h })), results)
    .map(({ hit }, i) => ({ rank: i + 1, score: Math.round(hit.score * 100) / 100, words: hit.words, ...shape(hit.notePath, hit.n) }));
  timings.readMs = Math.round(performance.now() - t);
  return { results, exactWords, timings };
}

/**
 * @param {import('../sync/run.js').Context} ctx
 * @param {{ queries: string[], count?: number, noSync?: boolean, exactWords?: boolean }} opts
 * @param {import('../cli/output.js').Ui} ui
 */
export async function runSearch(ctx, opts, ui) {
  const t0 = performance.now();
  const timings = { syncMs: 0, modelAndEmbedMs: 0, engineMs: 0, probeMs: 0, searchMs: 0, wordsMs: 0, readMs: 0 };
  const v = /** @type {NonNullable<typeof ctx.cfg.vault>} */ (ctx.cfg.vault);
  const count = Math.max(1, Math.min(50, opts.count ?? v.resultCount));
  setLogDir(path.join(ctx.indexDir, 'logs'));
  let loaded = loadManifest(ctx.indexDir);
  if (!loaded || loaded.manifest.totals.passages === 0) throw new VmError('VM_E_NOT_SYNCED');

  // A quick sync first, only when the waiting work is small.
  /** @type {string | null} */
  let syncNotice = null; let inStep = false;
  /** @type {import('../engine/engine.js').Engine | null} */
  let syncEngine = null;
  const running = liveOwner(path.join(ctx.indexDir, 'sync.lock'));
  if (running) {
    const p = readProgress(ctx.indexDir);
    syncNotice = `A sync is running${p ? ` (${p.percent}% done)` : ''}. This search covers what is saved so far.`;
  } else if (!opts.noSync) {
    const quiet = { ...ui, out() {}, info() {}, progress() {}, progressEnd() {} };
    try {
      const r = /** @type {any} */ (await runSync(ctx, { quickMaxPassages: v.searchAutoSyncMaxPassages }, quiet));
      if (r.deferred) syncNotice = r.waiting ? `${plural(r.waiting, 'note')} ${r.waiting === 1 ? 'is' : 'are'} waiting to sync. This search covers what is indexed so far. Next: vault-mirror sync --detach` : 'The index needs a sync. This search covers what is indexed so far. Next: vault-mirror sync --detach';
      else { inStep = r.nothing ? true : Boolean(r.inStep); loaded = loadManifest(ctx.indexDir) || loaded; syncEngine = r.engine || null; }
    } catch (e) {
      if (e instanceof VmError && (e.code === 'VM_E_BUSY' || e.code === 'VM_E_LOCK_LOST')) syncNotice = 'A sync is running. This search covers what is saved so far.';
      else if (e instanceof VmError && e.exitCode === 4) syncNotice = `${e.message} This search covers what is indexed so far.`;
      else throw e;
    }
  } else syncNotice = unfinishedNotice(loaded.manifest);
  timings.syncMs = Math.round(performance.now() - t0);
  const first = loaded;
  const dimensions = Number(first.manifest.embedding.dimensions);

  // The engine probe runs in a child process while this process loads the model and reads the question.
  let t = performance.now();
  const engineFor = (/** @type {{ manifest: import('../store/manifest.js').Manifest, dataDir: string }} */ l) => ensureEngine({ indexDir: ctx.indexDir, loaded: l, dimensions });
  // A quick sync that did real work already opened the engine in this process. The file's lock is held until
  // exit, so a probe child could not open it: use that handle.
  const enginePromise = syncEngine
    ? Promise.resolve(/** @type {import('../engine/build.js').EngineResult} */ ({ engine: syncEngine, how: 'used', seconds: 0, notices: [], warnings: [], probeMs: 0, loaded: first }))
    : engineFor(first);
  enginePromise.catch(() => {}); // handled below
  const embedder = createEmbedder({ model: String(first.manifest.embedding.model), debug, notice: (line) => ui.info(line) });
  const registry = lookupVault(ctx.vault.real);
  if (registry.state !== 'registered' && !(registry.state === 'no-list' && registry.vaultParam)) ui.warn('Open this folder as a vault in Obsidian once, and links will work.');
  /** @type {Awaited<ReturnType<typeof searchReady>>} */
  let found;
  /** @type {import('../engine/build.js').EngineResult} */
  let eng;
  /** @type {import('../store/manifest.js').Manifest} */
  let manifest;
  try {
    await embedder.init({ queries: opts.queries });
    timings.modelAndEmbedMs = Math.round(performance.now() - t);

    // A sync that replaced or removed a note ends with a tidy rewrite, which removes the data folder this
    // search loaded. Everything that reads that folder runs here, so it is re-read from CURRENT and run once more.
    ({ eng, manifest, found } = await withLiveData(ctx.indexDir, first, async (l) => {
      t = performance.now();
      const eng = await (l === first ? enginePromise : engineFor(l));
      timings.engineMs = Math.round(performance.now() - t); timings.probeMs = eng.probeMs;
      const { manifest, dataDir } = eng.loaded; // the manifest the engine was brought in step with
      t = performance.now();
      const words = opts.exactWords === false ? null : loadWords(ctx.indexDir, eng.loaded, !liveOwner(path.join(ctx.indexDir, 'sync.lock')));
      const tableMs = performance.now() - t;
      const found = await searchReady({ embedder, engine: eng.engine, manifest, dataDir, words }, { queries: opts.queries, count, vaultPath: ctx.vault.real, vaultParam: registry.vaultParam });
      found.timings.wordsMs = Math.round(found.timings.wordsMs + tableMs);
      return { eng, manifest, found };
    }));
  } finally { await embedder.shutdown(); }
  timings.modelAndEmbedMs += found.timings.embedMs;
  timings.searchMs = found.timings.searchMs; timings.wordsMs = found.timings.wordsMs; timings.readMs = found.timings.readMs;
  const { results, exactWords } = found;
  for (const n of eng.notices) ui.warn(n);
  for (const w of eng.warnings) ui.warnings.push(w);
  const tookMs = Math.round(performance.now() - t0);
  runLine('search', { results: results.length, exact_words: exactWords.length, phrasings: opts.queries.length, ms: tookMs }); // never the question text
  return { query: opts.queries[0], queries: opts.queries, results, exactWords, searched: { notes: manifest.totals.notes, passages: manifest.totals.passages }, inStep, syncNotice, tookMs, timings, engine: eng.engine.name };
}
