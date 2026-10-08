// @ts-check
import path from 'node:path';
import { loadContext } from '../context.js';
import { runSync, printSyncSummary } from '../../sync/run.js';
import { startDetached } from '../../sync/detach.js';
import { liveOwner } from '../../store/lock.js';
import { readProgress } from '../../sync/progress.js';
import { ensureDir } from '../../store/safe-write.js';
import { VmError } from '../../errors.js';
import { parseWorkers } from '../flags.js';

/**
 * @param {{ detach?: boolean, workers?: string, fullSpeed?: boolean, wait?: string, allowMassDelete?: boolean, verify?: boolean }} args
 * @param {import('../output.js').Ui} ui
 */
export async function syncCommand(args, ui) {
  // A mistyped flag is said first, before the vault is looked for or a note is read.
  const workers = parseWorkers(args.workers);
  const waitSeconds = args.wait == null ? undefined : Number(args.wait);
  if (waitSeconds != null && !Number.isFinite(waitSeconds)) throw new VmError('VM_E_USAGE', { detail: '--wait takes a number of seconds.' });
  const ctx = loadContext({ needVault: true });
  const vault = { name: ctx.vault.name, path: ctx.vault.real };

  if (args.detach) {
    ensureDir(ctx.indexDir);
    const owner = liveOwner(path.join(ctx.indexDir, 'sync.lock'));
    if (owner) {
      const p = readProgress(ctx.indexDir);
      ui.out(`A sync is already running${p ? ` (${p.percent}% done)` : ''}. Ask "is my vault in sync?" to see progress.`);
      return { vault, body: { detached: false, alreadyRunning: true, pid: owner.pid } };
    }
    const pass = [];
    if (args.workers != null) pass.push('--workers', String(args.workers));
    if (args.fullSpeed) pass.push('--full-speed');
    if (args.allowMassDelete) pass.push('--allow-mass-delete');
    if (args.verify) pass.push('--verify');
    const child = startDetached(ctx.indexDir, pass);
    ui.out('Sync started in the background. Ask "is my vault in sync?" to see progress.');
    return { vault, body: { detached: true, alreadyRunning: false, pid: child.pid } };
  }

  const r = /** @type {any} */ (await runSync(ctx, { workers, fullSpeed: args.fullSpeed, waitSeconds, allowMassDelete: args.allowMassDelete, verify: args.verify }, ui));
  printSyncSummary(r, ui);
  const flagged = 0;
  void flagged;
  return { vault, body: { inStep: r.inStep, complete: r.complete, counts: r.counts, passages: r.passages, seconds: r.seconds, resources: r.resources, skippedNotes: r.skippedNotes } };
}
