// @ts-check
// The two things the server does not do itself. `vault_status` and `sync_index` run the same commands a
// person would type, each in a process of its own that ends when its work is done. That keeps their
// answers word for word the commands' answers, and it keeps the long-lived server from ever holding the
// index open: a command lets go of it when it exits.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { liveOwner, pidAlive } from '../store/lock.js';
import { ensureDir } from '../store/safe-write.js';
import { startDetached } from '../sync/detach.js';
import { readProgress } from '../sync/progress.js';
import { VmError } from '../errors.js';
import { leanStatus, leanSync } from './shape.js';

const BIN = fileURLToPath(new URL('../../bin/vault-mirror.js', import.meta.url));

/**
 * An error a command reported in its own words: one plain sentence and one next step.
 * @param {{ code?: string, message?: string, next?: string }} e
 * @returns {Error & { code: string, next: string, fromCommand: true }}
 */
export function commandProblem(e) {
  return Object.assign(new Error(String(e.message || 'The command did not finish.')), { code: String(e.code || 'VM_E_INTERNAL'), next: String(e.next || 'Run `vault-mirror doctor`.'), fromCommand: /** @type {const} */ (true) });
}

/** The one JSON object a `--json` command prints, or null. @param {string} text */
export function lastJson(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) { try { const j = JSON.parse(lines[i]); if (j && typeof j === 'object') return j; } catch { /* not this line */ } }
  return null;
}

/** @param {Record<string, any> | null} json */
function okOrThrow(json) {
  if (!json) throw new VmError('VM_E_INTERNAL');
  if (json.ok === false) throw commandProblem(json.error || {});
  return json;
}

/** @type {Set<import('node:child_process').ChildProcess>} */
const running = new Set();

/**
 * Run one vault-mirror command with --json and hand back its object.
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<Record<string, any>>}
 */
export function runCommand(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args, '--json'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: process.env });
    running.add(child);
    let out = ''; let done = false;
    const finish = (/** @type {() => void} */ then) => { if (done) return; done = true; clearTimeout(timer); running.delete(child); then(); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(() => reject(new VmError('VM_E_INDEX_BUSY'))); }, opts.timeoutMs ?? 120000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d) => { out += d; });
    child.on('error', () => finish(() => reject(new VmError('VM_E_INTERNAL'))));
    child.on('close', () => finish(() => { try { resolve(okOrThrow(lastJson(out))); } catch (e) { reject(e); } }));
  });
}

/** Stop any command still running (the server is closing). A sync started by `sync_index` is not one of these: it finishes by itself. */
export function stopCommands() {
  for (const child of running) { try { child.kill(); } catch { /* gone */ } }
  running.clear();
}

/** "Is my vault in sync?" */
export async function vaultStatus() {
  return leanStatus(await runCommand(['status']));
}

/**
 * Bring the index up to date. The sync is the same background process `sync --detach` starts. This waits
 * for it up to `waitSeconds`, then answers with the result, or with how far it is.
 * @param {import('../sync/run.js').Context} ctx
 * @param {{ waitSeconds: number, pollMs?: number }} opts
 */
export async function syncIndex(ctx, opts) {
  const lockFile = path.join(ctx.indexDir, 'sync.lock');
  const deadline = Date.now() + opts.waitSeconds * 1000;
  const until = async (/** @type {() => boolean} */ over) => {
    for (;;) {
      if (over()) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 200));
    }
  };
  const vault = ctx.vault.name;
  ensureDir(ctx.indexDir);
  if (liveOwner(lockFile)) {
    // One is already running. It is left to carry on; a second one is never started beside it.
    if (!(await until(() => !liveOwner(lockFile)))) return leanSync({ vault, started: false, running: readProgress(ctx.indexDir) });
    return leanSync({ vault, started: false, status: await vaultStatus() });
  }
  const { pid, outFile } = startDetached(ctx.indexDir, ['--json']);
  if (!pid) throw new VmError('VM_E_INTERNAL');
  if (!(await until(() => !pidAlive(pid)))) return leanSync({ vault, started: true, running: readProgress(ctx.indexDir) });
  let text = '';
  try { text = fs.readFileSync(outFile, 'utf8'); } catch { /* reported below */ }
  return leanSync({ vault, started: true, done: okOrThrow(lastJson(text)) });
}
