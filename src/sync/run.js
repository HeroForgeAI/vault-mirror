// @ts-check
// The sync: bring the index in step with the vault. Resumable by design: a restarted sync
// is a normal sync in which most notes already match the manifest.
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { walkVault } from '../vault/walk.js';
import { readBytes, stat } from '../vault/read-only-fs.js';
import { chunk, PREFIX_CAP_TOKENS, ALIAS_CAP_TOKENS } from '../chunker/index.js';
import { buildPlan, safetyStops } from './plan.js';
import { createProgress, readProgress } from './progress.js';
import { createEmbedder, withEmbedder } from '../embed/embedder.js';
import { sameIdentity } from '../embed/model.js';
import { acquireLock } from '../store/lock.js';
import { ensureDir } from '../store/safe-write.js';
import { loadManifest, newManifest, saveManifest, switchCurrent, nextDataName, currentDataName } from '../store/manifest.js';
import { createDataDir, openSidecar } from '../store/sidecar.js';
import { recover } from '../store/recover.js';
import { tidyRewrite, removeOrphans } from '../store/rewrite.js';
import { wordsFor, wordsAtStamp, dropWords } from '../words/store.js';
import { ensureEngine, engineStamp } from '../engine/build.js';
import { loadedVersions } from '../engine/ruvector-loader.js';
import { passageId } from '../engine/engine.js';
import { screenText } from '../screen/screen.js';
import { chooseWorkers } from '../config/config.js';
import { VmError } from '../errors.js';
import { debug, runLine, noteKey, setLogDir } from '../log.js';
import { num, duration, plural, eta } from '../cli/output.js';
import { CHUNKER_VERSION, TOOL_VERSION } from '../version.js';

/**
 * @typedef {object} Context
 * @property {string} home
 * @property {ReturnType<import('../config/config.js').loadConfig>} cfg
 * @property {{ real: string, name: string, opened: boolean }} vault
 * @property {string} indexDir
 */

const WORDS_SAVE_EVERY_MS = 30000;

/** The settings that change chunk output, and their hash. @param {Context} ctx @param {import('../embed/embedder.js').Embedder} embedder */
export function chunkerBlock(ctx, embedder) {
  const v = /** @type {NonNullable<Context['cfg']['vault']>} */ (ctx.cfg.vault);
  const settings = { minWords: v.minWords, dropFences: [...v.dropFences].sort(), budgetTokens: embedder.budgetTokens, counter: embedder.counterName, prefixCap: PREFIX_CAP_TOKENS, aliasCap: ALIAS_CAP_TOKENS };
  return {
    version: CHUNKER_VERSION,
    settingsHash: crypto.createHash('sha256').update(JSON.stringify(settings)).digest('hex').slice(0, 16),
    budgetTokens: embedder.budgetTokens,
    counter: embedder.counterName,
  };
}

/** @param {import('../embed/embedder.js').Embedder} embedder @param {Record<string, any> | null} known */
function embeddingBlock(embedder, known) {
  return { ...embedder.identity(known), spaceId: null };
}

export function engineBlock() {
  const v = loadedVersions();
  return { name: 'ruvector', version: v.ruvector, core: v.core, native: v.native, index: 'flat', metric: 'cosine' };
}

/**
 * Walk the vault and classify every note, without changing anything. Used by status and by a search's first look.
 * @param {Context} ctx
 * @param {{ shallow: boolean, verify?: boolean, embedder?: import('../embed/embedder.js').Embedder | null, manifest: import('../store/manifest.js').Manifest | null }} o
 */
export async function planOnly(ctx, o) {
  const v = /** @type {NonNullable<Context['cfg']['vault']>} */ (ctx.cfg.vault);
  if (!stat(ctx.vault.real)?.isDir) throw new VmError('VM_E_VAULT_MISSING', { path: ctx.vault.real });
  const walk = walkVault(ctx.vault.real, { exclude: v.exclude, obsidianExcludes: v.obsidianExcludes });
  const embedder = o.embedder;
  const plan = await buildPlan({
    walk, manifest: o.manifest, shallow: o.shallow, verify: o.verify,
    read: (abs) => readBytes(abs), stat: (abs) => stat(abs),
    chunk: (bytes, key, fip) => {
      if (!embedder) throw new Error('a token counter is needed to chunk');
      return chunk(bytes, key, { countTokens: embedder.countTokens, budgetTokens: embedder.budgetTokens, minWords: v.minWords, dropFences: v.dropFences, folderInPrefix: fip });
    },
  });
  return { plan, walk };
}

/**
 * What a stopped run really did. Its plan counted every note it meant to read; only the notes whose
 * new passages were saved count as added, updated or renamed.
 * @template {{ added: number, updated: number, renamed: number, removed: number }} C
 * @param {C} counts
 * @param {Pick<import('./plan.js').Plan, 'toEmbed' | 'renamed' | 'removed' | 'dropped'>} plan
 * @param {Pick<import('../store/manifest.js').Manifest, 'notes'>} manifest
 * @returns {C}
 */
export function savedCounts(counts, plan, manifest) {
  const saved = new Set(plan.toEmbed.filter((n) => manifest.notes[n.key]?.sha256 === n.sha256).map((n) => n.key));
  const renamedTo = new Set(plan.renamed.map((r) => r.to));
  const renamed = plan.renamed.filter((r) => saved.has(r.to)).length;
  return {
    ...counts, renamed,
    added: plan.toEmbed.filter((n) => n.kind === 'added' && !renamedTo.has(n.key) && saved.has(n.key)).length,
    updated: plan.toEmbed.filter((n) => n.kind === 'updated' && saved.has(n.key)).length,
    removed: plan.removed.length - renamed + plan.dropped.length,
  };
}

/**
 * @param {Context} ctx
 * @param {object} opts
 * @param {number | 'auto'} [opts.workers]
 * @param {boolean} [opts.fullSpeed]
 * @param {number} [opts.waitSeconds]       how long to queue behind another sync
 * @param {boolean} [opts.allowMassDelete]
 * @param {boolean} [opts.verify]
 * @param {number} [opts.quickMaxPassages]  a search's quick sync: do nothing when more work than this is waiting
 * @param {boolean} [opts.fresh]            rebuild --full: start from an empty data folder
 * @param {import('../cli/output.js').Ui} ui
 */
export async function runSync(ctx, opts, ui) {
  const started = Date.now();
  const v = /** @type {NonNullable<Context['cfg']['vault']>} */ (ctx.cfg.vault);
  const quick = opts.quickMaxPassages != null;
  ensureDir(ctx.indexDir);
  setLogDir(path.join(ctx.indexDir, 'logs'));
  if (!stat(ctx.vault.real)?.isDir) throw new VmError('VM_E_VAULT_MISSING', { path: ctx.vault.real });

  const lock = await acquireLock(path.join(ctx.indexDir, 'sync.lock'), {
    command: 'sync', waitMs: quick ? 0 : (opts.waitSeconds ?? 600) * 1000,
    onWait: () => {
      const p = readProgress(ctx.indexDir);
      ui.info(p ? `Another sync is running (${p.percent}% done${p.etaSeconds != null ? `, ${eta(p.etaSeconds)}` : ''}). Waiting for it to finish.` : 'Another sync is running. Waiting for it to finish.');
    },
  }).catch((e) => {
    // Say how far the other sync is, in the human line and in --json alike.
    if (e instanceof VmError && e.code === 'VM_E_BUSY') throw new VmError('VM_E_BUSY', { percent: readProgress(ctx.indexDir)?.percent });
    throw e;
  });
  const embedder = createEmbedder({ model: ctx.cfg.embedding.model, debug, notice: (line) => ui.info(line) });
  /** @type {ReturnType<typeof openSidecar> | null} */
  let sidecar = null;
  let stopRequested = false;
  const onSignal = () => { stopRequested = true; };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(/** @type {NodeJS.Signals} */ (s), onSignal);

  try {
    return await withEmbedder(embedder, async () => {
      removeOrphans(ctx.indexDir, currentDataName(ctx.indexDir));
      let loaded = opts.fresh ? null : loadManifest(ctx.indexDir);
      if (!embedder.modelPresent) {
        if (quick) return { deferred: true, waiting: null };
        await embedder.init(); // a first run downloads the model here
      }
      const chunkerNow = chunkerBlock(ctx, embedder);
      const embeddingNow = embeddingBlock(embedder, loaded ? loaded.manifest.embedding : null);
      const versionChanged = Boolean(loaded) && (loaded?.manifest.chunker.version !== chunkerNow.version || loaded?.manifest.chunker.settingsHash !== chunkerNow.settingsHash || !sameIdentity(loaded?.manifest.embedding, embeddingNow));
      if (loaded && !versionChanged) {
        const r = recover(loaded.dataDir, loaded.manifest, embedder.dimensions);
        if (r.changed) { debug(`recovery folded=${r.folded} droppedBytes=${r.droppedBytes}`); saveManifest(loaded.dataDir, loaded.manifest, r.folded > 0); }
      }
      if (!loaded || versionChanged) {
        if (quick) return { deferred: true, waiting: null };
        if (versionChanged) ui.info('The way notes are read changed. Re-reading every note once.');
        const previous = currentDataName(ctx.indexDir);
        const dataName = nextDataName(previous);
        const dataDir = path.join(ctx.indexDir, dataName);
        const manifest = newManifest({ dataName, vault: { name: ctx.vault.name, path: ctx.vault.real, pathHash: path.basename(ctx.indexDir).slice(-8) }, chunker: chunkerNow, embedding: embeddingNow, engine: engineBlock() });
        manifest.sidecar.logBytes = createDataDir(dataDir, { embedding: embeddingNow, chunker: chunkerNow });
        dropWords(ctx.indexDir); // every note is read again, so the exact-words table starts again too
        saveManifest(dataDir, manifest);
        switchCurrent(ctx.indexDir, dataName);
        removeOrphans(ctx.indexDir, dataName);
        loaded = { manifest, dataName, dataDir };
      }
      let { manifest, dataName, dataDir } = loaded;
      manifest.embedding = embeddingNow;
      const stampAtStart = manifest.stamp;

      // Plan: what changed.
      const walk = walkVault(ctx.vault.real, { exclude: v.exclude, obsidianExcludes: v.obsidianExcludes });
      if (quick) {
        const first = await buildPlan({ walk, manifest, shallow: true, read: (abs) => readBytes(abs), stat: (abs) => stat(abs), chunk: () => { throw new Error('unused'); } });
        const waitingNotes = first.pending.new + first.pending.changed + first.pending.removed;
        if (waitingNotes === 0 && first.respelled.length === 0 && manifest.sidecar.deadRecords === 0) return { deferred: false, nothing: true, plan: first };
        if (waitingNotes > /** @type {number} */ (opts.quickMaxPassages)) return { deferred: true, waiting: waitingNotes };
      }
      const plan = await buildPlan({
        walk, manifest, verify: opts.verify,
        read: (abs) => readBytes(abs), stat: (abs) => stat(abs),
        chunk: (bytes, key, fip) => chunk(bytes, key, { countTokens: embedder.countTokens, budgetTokens: embedder.budgetTokens, minWords: v.minWords, dropFences: v.dropFences, folderInPrefix: fip }),
      });
      for (const w of plan.warnings) ui.warn(w);
      safetyStops(plan, manifest, { vaultPath: ctx.vault.real, allowMassDelete: opts.allowMassDelete });
      if (quick && plan.passagesToEmbed > /** @type {number} */ (opts.quickMaxPassages)) return { deferred: true, waiting: plan.toEmbed.length };

      const renamedTo = new Set(plan.renamed.map((r) => r.to));
      const counts = {
        seen: plan.seen, added: plan.toEmbed.filter((n) => n.kind === 'added' && !renamedTo.has(n.key)).length,
        updated: plan.toEmbed.filter((n) => n.kind === 'updated').length, renamed: plan.renamed.length,
        removed: plan.removed.length - plan.renamed.length + plan.dropped.length, unchanged: plan.unchanged,
        leftOut: plan.leftOutList.length, skipped: plan.skipped.length, otherFiles: plan.otherFiles,
      };
      const leavingKeys = [...plan.removed, ...plan.dropped.map((d) => d.key)];
      const work = plan.toEmbed.length + leavingKeys.length;
      const { workers, note: workerNote } = chooseWorkers(opts.workers ?? v.workers);
      const big = plan.passagesToEmbed >= 32; // enough work to be felt: under that, single calls in the main thread
      const usePool = big && workers > 0;
      const lowPriority = big && !opts.fullSpeed;

      if (work > 0 && !quick) {
        if (big) {
          ui.info(`Syncing ${ctx.vault.name} with ${plural(usePool ? workers : 1, 'reader')}${lowPriority ? ', at low priority' : ''}. It only reads your notes.`);
          if (lowPriority) ui.info('Your computer may feel a little slower and its fan may run while this reads your notes. That is normal. You can keep working, and it picks up where it left off if it is interrupted.');
          if (workerNote) ui.info(workerNote);
        }
        ui.info(`Checked ${plural(plan.seen, 'note')}: ${num(counts.added + counts.renamed)} new, ${num(counts.updated)} changed, ${num(counts.removed + counts.renamed)} removed, ${num(counts.leftOut)} left out.${plan.otherFiles ? ` ${plural(plan.otherFiles, 'other file')} (images, PDFs and the like) ${plan.otherFiles === 1 ? 'is not a note and was' : 'are not notes and were'} not read.` : ''}`);
      }

      /** @type {{ path: string, reason: string }[]} */
      const skippedNotes = plan.skipped.map((s) => ({ path: s.key, reason: s.reason }));
      for (const s of plan.skipped) debug(`skipped note=${noteKey(s.key)} reason=${s.reason}`);
      let embedded = 0; let notesDone = 0; let bookkeeping = false; let flaggedNotes = 0;
      /** @type {string[]} */
      const removeIds = [];
      /** @type {import('../engine/engine.js').Row[] | null} */
      let addRows = plan.passagesToEmbed <= 512 ? [] : null;
      const fenced = () => { if (!lock.stillOurs()) throw new VmError('VM_E_LOCK_LOST'); };
      // The exact-words table follows the saved passages. It is a copy that can always be made again,
      // so a failure here never fails the sync: the next search, status or sync brings it in step.
      let wordsSavedAt = Date.now();
      const saveWords = () => {
        try { fenced(); wordsFor(ctx.indexDir, { manifest, dataDir }, { save: true }); wordsSavedAt = Date.now(); }
        catch (e) { if (e instanceof VmError) throw e; debug(`the exact-words table was not saved: ${String(/** @type {any} */ (e)?.message).slice(0, 160)}`); }
      };

      for (const t of plan.touched) { Object.assign(manifest.notes[t.key], { size: t.size, mtimeMs: t.mtimeMs, racy: t.racy }); bookkeeping = true; }
      for (const r of plan.respelled) { const e = manifest.notes[r.key]; if (r.file === r.key) delete e.file; else e.file = r.file; bookkeeping = true; }
      if (JSON.stringify(manifest.leftOut) !== JSON.stringify(plan.leftOutKept)) { manifest.leftOut = plan.leftOutKept; bookkeeping = true; }

      if (work > 0) {
        sidecar = openSidecar(dataDir, manifest.sidecar, embedder.dimensions);
        const side = sidecar;
        // Removals first: they are cheap, and a removed note should stop appearing at once.
        if (leavingKeys.length) {
          fenced();
          side.appendDels(leavingKeys);
          for (const key of leavingKeys) {
            const entry = manifest.notes[key];
            if (!entry) continue;
            for (let i = 0; i < entry.passages; i++) removeIds.push(passageId(key, i));
            delete manifest.notes[key];
            manifest.sidecar.deadRecords++;
          }
          manifest.sidecar.logBytes = side.logBytes;
          saveManifest(dataDir, manifest);
        }

        if (plan.toEmbed.length) {
          if (lowPriority) { try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not allowed here: carry on */ } }
          await embedder.init();
          if (usePool) await embedder.startPool(workers);
          const progress = createProgress(ctx.indexDir, { notesTotal: plan.toEmbed.length, passagesTotal: plan.passagesToEmbed });
          const embedStart = Date.now();
          let target = 16; let failedNotes = 0;
          const tick = (/** @type {number} */ extra, /** @type {boolean} */ force) => {
            progress.update({ notesDone, passagesDone: embedded + extra }, force);
            if (!quick) ui.progress({ done: embedded + extra, total: plan.passagesToEmbed, rate: progress.state.rate, etaSeconds: progress.state.etaSeconds });
          };
          tick(0, true);
          try {
            for (let i = 0; i < plan.toEmbed.length && !stopRequested;) {
              /** @type {import('./plan.js').PlannedNote[]} */
              const batch = []; let size = 0;
              while (i < plan.toEmbed.length && (size === 0 || size + plan.toEmbed[i].passages.length <= target)) { batch.push(plan.toEmbed[i]); size += plan.toEmbed[i].passages.length; i++; }
              const texts = batch.flatMap((n) => n.passages.map((p) => p.embedText));
              /** @type {(Float32Array | null)[]} */
              const vectors = [];
              // A note with more passages than one request is sent in slices and committed only when all are back.
              for (let s = 0; s < texts.length; s += target) { vectors.push(...await embedder.embedPassages(texts.slice(s, s + target))); tick(vectors.length, false); }
              /** @type {Parameters<ReturnType<typeof openSidecar>['appendPuts']>[0]} */
              const puts = []; const good = [];
              let at = 0;
              for (const note of batch) {
                const mine = vectors.slice(at, at + note.passages.length); at += note.passages.length;
                if (mine.some((x) => !x)) { failedNotes++; skippedNotes.push({ path: note.key, reason: 'embed-failed' }); debug(`skipped note=${noteKey(note.key)} reason=embed-failed`); continue; }
                const passages = note.passages.map((p) => {
                  const flags = v.screen === 'report' ? screenText(p.text).flags : [];
                  return { n: p.n, trail: p.trail, ...(p.heads.length ? { heads: p.heads } : {}), ...(p.headRepeats ? { rep: true } : {}), line: p.line, text: p.text, flags, ...(p.recovered ? { recovered: true } : {}) };
                });
                puts.push({ record: { v: 1, op: 'put', path: note.key, sha256: note.sha256, size: note.size, mtimeMs: note.mtimeMs, fip: note.folderInPrefix, title: note.title, passages }, vectors: /** @type {Float32Array[]} */ (mine) });
                good.push(note);
              }
              if (puts.length) {
                fenced();
                const where = side.appendPuts(puts);
                good.forEach((note, k) => {
                  const old = manifest.notes[note.key];
                  if (old) { manifest.sidecar.deadRecords++; for (let p = 0; p < old.passages; p++) removeIds.push(passageId(note.key, p)); }
                  manifest.notes[note.key] = { sha256: note.sha256, size: note.size, mtimeMs: note.mtimeMs, racy: note.racy, passages: note.passages.length, folderInPrefix: note.folderInPrefix, log: where[k].log, vec: where[k].vec, flagged: puts[k].record.passages.filter((p) => p.flags.length).length, ...(note.file !== note.key ? { file: note.file } : {}) };
                  if (addRows) puts[k].vectors.forEach((vec, p) => /** @type {import('../engine/engine.js').Row[]} */ (addRows).push({ id: passageId(note.key, p), vector: vec }));
                });
                manifest.sidecar.logBytes = side.logBytes; manifest.sidecar.vectors = side.vectors;
                flaggedNotes += puts.filter((p) => p.record.passages.some((x) => x.flags.includes('possible-secret'))).length;
                saveManifest(dataDir, manifest);
                if (Date.now() - wordsSavedAt >= WORDS_SAVE_EVERY_MS) saveWords(); // a long first sync: searches meanwhile find exact words too
              }
              embedded += size; notesDone += batch.length;
              tick(0, true);
              const rate = embedded / Math.max(0.001, (Date.now() - embedStart) / 1000);
              target = Math.max(8, Math.min(128, Math.round(rate * 5)));
              if (failedNotes > 20 || (notesDone >= 8 && failedNotes / notesDone >= 0.25)) throw new VmError('VM_E_EMBED_FAILING');
            }
          } finally { ui.progressEnd(); progress.done(); }
        }
        side.close(); sidecar = null;
      }

      const complete = !stopRequested || notesDone === plan.toEmbed.length;
      counts.skipped = skippedNotes.length;
      const seconds = () => Math.round((Date.now() - started) / 100) / 10;
      const did = complete ? counts : savedCounts(counts, plan, manifest);
      if (work > 0 || bookkeeping) {
        if (work > 0) manifest.lastRun = { at: new Date().toISOString(), seconds: seconds(), complete, counts: did };
        manifest.engine = engineBlock();
        saveManifest(dataDir, manifest, false);
      }
      if (!complete) {
        runLine('sync', { seen: did.seen, added: did.added, updated: did.updated, renamed: did.renamed, removed: did.removed, unchanged: did.unchanged, left_out: did.leftOut, skipped: did.skipped, passages: manifest.totals.passages, embedded, seconds: seconds(), result: 'stopped', v: TOOL_VERSION });
        throw new VmError('VM_E_STOPPED', { done: num(notesDone), total: num(plan.toEmbed.length) });
      }

      // The tidy rewrite: no old text is kept.
      if (manifest.sidecar.deadRecords > 0) {
        fenced();
        ({ manifest, dataName, dataDir } = tidyRewrite(ctx.indexDir, dataName, manifest, embedder.dimensions));
      }
      if ((manifest.totals.passages > 0 || work > 0) && !wordsAtStamp(ctx.indexDir, manifest)) saveWords();

      // Bring the engine in step. If the index is busy the sync still ends well: everything is saved.
      let engineNote = null;
      /** @type {import('../engine/engine.js').Engine | null} */
      let engine = null; // this process now holds the engine file open; a caller that searches next must use this handle
      const eng = engineStamp(ctx.indexDir);
      if (manifest.totals.passages > 0 && (!eng || eng.stamp !== manifest.stamp)) {
        await embedder.shutdown(); // the readers are done; free their memory before the engine loads
        try {
          // Apply just the changed notes only when no note left the index: a deleted id can linger in an
          // engine file's freed pages, and a removed note's name must appear nowhere. A fresh file has no history.
          const delta = addRows && eng && eng.stamp === stampAtStart && leavingKeys.length === 0 ? { fromStamp: stampAtStart, removeIds, addRows } : null;
          const r = await ensureEngine({ indexDir: ctx.indexDir, loaded: { manifest, dataDir }, dimensions: embedder.dimensions, quiet: true, delta });
          for (const n of r.notices) ui.warn(n);
          for (const w of r.warnings) ui.warnings.push(w);
          engine = r.engine;
        } catch (e) {
          if (!(e instanceof VmError) || e.code !== 'VM_E_INDEX_BUSY') throw e;
          engineNote = 'Everything is saved. The index is in use right now, so the next search or status will load it.';
        }
      }

      const total = { notes: manifest.totals.notes, passages: manifest.totals.passages };
      const inStep = skippedNotes.length === 0 && manifest.sidecar.deadRecords === 0;
      const usage = process.resourceUsage();
      const result = {
        inStep, complete: true, counts, leftOutByReason: plan.leftOut,
        passages: { total: total.passages, embedded }, seconds: seconds(),
        resources: { workers: usePool ? workers : 0, lowPriority, peakRssMB: Math.round(usage.maxRSS / 1024), cpuSeconds: Math.round((usage.userCPUTime + usage.systemCPUTime) / 1e5) / 10 },
        skippedNotes, flaggedNotes, nothing: work === 0, notesInIndex: total.notes, eligible: plan.eligible, engineNote, engine,
      };
      if (work > 0 || !quick) {
        runLine('sync', { seen: counts.seen, added: counts.added, updated: counts.updated, renamed: counts.renamed, removed: counts.removed, unchanged: counts.unchanged, left_out: counts.leftOut, skipped: counts.skipped, passages: total.passages, embedded, seconds: result.seconds, result: inStep ? 'in-step' : 'not-yet', v: TOOL_VERSION });
      }
      return result;
    });
  } finally {
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(/** @type {NodeJS.Signals} */ (s), onSignal);
    try { if (sidecar) /** @type {any} */ (sidecar).close(); } catch { /* closing */ }
    lock.release();
  }
}

/** Why notes were skipped, as one plain sentence. @param {{ path: string, reason: string }[]} skipped */
export function skippedSentence(skipped) {
  const n = skipped.length;
  const reasons = new Set(skipped.map((s) => s.reason));
  const why = reasons.size === 1 && reasons.has('changing') ? `${n === 1 ? 'was' : 'were'} being saved while ${n === 1 ? 'it was' : 'they were'} read`
    : reasons.size === 1 && reasons.has('unreadable') ? 'could not be read'
      : reasons.size === 1 && reasons.has('embed-failed') ? 'could not be read into the model'
        : 'could not be synced this time';
  return `In step: not yet. ${plural(n, 'note')} ${why}. Run vault-mirror sync again.`;
}

/** The human summary of a finished sync. @param {Awaited<ReturnType<typeof runSync>>} r @param {import('../cli/output.js').Ui} ui */
export function printSyncSummary(r, ui) {
  const res = /** @type {any} */ (r);
  const line = `${plural(res.eligible, 'note')} on disk = ${plural(res.notesInIndex, 'note')} in the index (${plural(res.passages.total, 'passage')})`;
  if (res.skippedNotes.length) { ui.out(skippedSentence(res.skippedNotes)); return; }
  if (res.nothing) { ui.out(`Nothing changed. In step: ${line}. ${duration(res.seconds)}.`); return; }
  ui.out(`Done in ${duration(res.seconds)}. In step: ${line}.`);
  const c = res.counts;
  ui.out(`added ${num(c.added)} · updated ${num(c.updated)} · renamed ${num(c.renamed)} · removed ${num(c.removed)} · unchanged ${num(c.unchanged)} · left out ${num(c.leftOut)}`);
  if (res.flaggedNotes) ui.out(`${plural(res.flaggedNotes, 'note')} ${res.flaggedNotes === 1 ? 'contains' : 'contain'} something that looks like a password or key. See: vault-mirror status --screen`);
  if (res.engineNote) ui.info(res.engineNote);
}
