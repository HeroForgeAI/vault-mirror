// @ts-check
// rebuild: the one "fix it yourself" move. The notes are the original and the index is a copy,
// so a rebuild is always safe.
import path from 'node:path';
import readline from 'node:readline';
import { loadContext } from '../context.js';
import { loadManifest, withLiveData } from '../../store/manifest.js';
import { ensureEngine } from '../../engine/build.js';
import { wordsFor, dropWords } from '../../words/store.js';
import { computeStatus } from '../../status/checks.js';
import { runSync, printSyncSummary } from '../../sync/run.js';
import { debug, setLogDir } from '../../log.js';
import { VmError } from '../../errors.js';
import { duration, plural } from '../output.js';

/** @param {string} question */
function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => { rl.close(); resolve(/^y(es)?$/i.test(answer.trim())); });
  });
}

/**
 * Make the exact-words table again from the saved passages. A saved passage that cannot be read must
 * not fail a rebuild: the table that could not be made again is removed, so `status` shows it, and
 * the caller names the one next action.
 * @param {string} indexDir @param {{ manifest: import('../../store/manifest.js').Manifest, dataDir: string }} loaded
 * @returns {Promise<boolean>}   false when the saved passages could not be read
 */
export async function remakeWords(indexDir, loaded) {
  try {
    // A sync's tidy rewrite can replace the data folder mid-read: read once more from the current one.
    await withLiveData(indexDir, loaded, async (l) => wordsFor(indexDir, l, { save: true, fresh: true }));
    return true;
  } catch (e) {
    debug(`the exact-words table could not be made again: ${String(/** @type {any} */ (e)?.message).slice(0, 160)}`);
    try { dropWords(indexDir); } catch { /* status reports whatever is left */ }
    return false;
  }
}

/**
 * @param {{ full?: boolean, yes?: boolean, workers?: string, fullSpeed?: boolean }} args
 * @param {import('../output.js').Ui} ui
 */
export async function rebuildCommand(args, ui) {
  const ctx = loadContext({ needVault: true });
  const vault = { name: ctx.vault.name, path: ctx.vault.real };
  setLogDir(path.join(ctx.indexDir, 'logs'));
  const started = Date.now();
  if (args.full) {
    const workers = args.workers == null ? undefined : args.workers === 'auto' ? 'auto' : Number(args.workers);
    if (typeof workers === 'number' && (!Number.isFinite(workers) || workers < 0)) throw new VmError('VM_E_USAGE', { detail: '--workers takes a number, for example --workers 2.' });
    if (!args.yes) {
      if (!process.stdin.isTTY || ui.json) throw new VmError('VM_E_USAGE', { detail: 'A full rebuild re-reads every note. To go ahead without being asked, add --yes.' });
      if (!(await confirm('This re-reads every note from scratch. Your notes are not touched. Go ahead? (y/n) '))) { ui.out('Nothing was changed.'); return { vault, body: { mode: 'full', passages: 0, seconds: 0, inStep: false, next: null, cancelled: true } }; }
    }
    const r = /** @type {any} */ (await runSync(ctx, { fresh: true, workers, fullSpeed: args.fullSpeed, allowMassDelete: true }, ui));
    printSyncSummary(r, ui);
    return { vault, body: { mode: 'full', passages: r.passages.total, seconds: r.seconds, inStep: r.inStep, next: null } };
  }
  const loaded = loadManifest(ctx.indexDir);
  if (!loaded || loaded.manifest.totals.passages === 0) throw new VmError('VM_E_NOT_SYNCED');
  const r = await ensureEngine({ indexDir: ctx.indexDir, loaded, dimensions: Number(loaded.manifest.embedding.dimensions), forceRebuild: true, quiet: true });
  for (const n of r.notices) ui.warn(n);
  const wordsMade = await remakeWords(ctx.indexDir, r.loaded); // the exact-words table is made again from saved passages too
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  ui.out(`Rebuilt the index from saved passages in ${duration(seconds)} (${plural(loaded.manifest.totals.passages, 'passage')}). Nothing was re-read.`);
  const quiet = { ...ui, warn() {} };
  const s = await computeStatus(ctx, { engine: r.engine }, quiet);
  const pending = s.counts.pending.new + s.counts.pending.changed + s.counts.pending.removed;
  let next = null;
  const inStep = s.inStep && wordsMade;
  if (inStep) ui.out('In step: yes.');
  else if (s._indexLooksWrong || r.how === 'exact' || !wordsMade) { next = 'vault-mirror rebuild --full'; ui.out('In step: not yet. The saved passages themselves look wrong.'); ui.out(`Next: ${next}`); }
  else { next = 'vault-mirror sync'; ui.out(`In step: not yet. ${plural(pending, 'note')} ${pending === 1 ? 'is' : 'are'} waiting to sync.`); ui.out(`Next: ${next}`); }
  return { vault, body: { mode: 'engine', passages: loaded.manifest.totals.passages, seconds, inStep, next } };
}
