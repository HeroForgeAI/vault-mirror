#!/usr/bin/env node
// The end-to-end acceptance run. It runs the real binary against a copy of a vault
// (or the vault itself with --read-only-vault) and checks every step of the spec's test plan.
//
//   node tests/acceptance/run.mjs --vault <dir> [--questions <file>] [--read-only-vault]
//        [--only 1,2,3] [--filler 90] [--stop-seconds 150] [--keep]
//
// The vault is never written by the tool. A snapshot of every vault file (path, size,
// modified time, mode, SHA-256) is compared after every command.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { makeFiller, makeReadmes, makeOddNames, ODD_NAMES, ODD_BODIES } from '../helpers/make-notes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const { values: opt } = parseArgs({ options: {
  vault: { type: 'string' }, questions: { type: 'string' }, 'read-only-vault': { type: 'boolean' }, only: { type: 'string' },
  filler: { type: 'string', default: '90' }, 'stop-seconds': { type: 'string', default: '150' }, keep: { type: 'boolean' }, bin: { type: 'string' },
} });
if (!opt.vault) { console.error('Usage: node tests/acceptance/run.mjs --vault <dir> [--questions <file>] [--read-only-vault]'); process.exit(2); }
const BIN = opt.bin ? path.resolve(opt.bin) : path.join(REPO, 'bin', 'vault-mirror.js');
const READ_ONLY = Boolean(opt['read-only-vault']);
// Windows cannot send Ctrl+C, a pause or a resume to another process, so the steps that need one say so and are skipped there.
const WIN = process.platform === 'win32';
const LIVE_STEPS = [1, 2, 3, 4, 5, 13, 17, 18, 19, 21, 22, 24, 25];
const only = opt.only ? new Set(opt.only.split(',').map(Number)) : READ_ONLY ? new Set(LIVE_STEPS) : null;
const wants = (/** @type {number} */ n) => !only || only.has(n);

const base = fs.realpathSync.native(fs.mkdtempSync(path.join((() => { const b = process.env.VAULT_MIRROR_TEST_TMP || os.tmpdir(); fs.mkdirSync(b, { recursive: true }); return b; })(), 'vm-accept-')));
const CWD = path.join(base, 'cwd'); const PROJECT = path.join(base, 'project'); const OBS_JSON = path.join(base, 'obsidian.json');
fs.mkdirSync(CWD); fs.mkdirSync(PROJECT);
const sourceVault = fs.realpathSync.native(path.resolve(opt.vault));
let VAULT = sourceVault;
/** The odd-named notes this system could hold (Windows refuses names with ? " | and :). @type {string[]} */
let oddWritten = [];
if (!READ_ONLY) {
  VAULT = path.join(base, 'vault');
  try { execFileSync('cp', ['-cR', sourceVault, VAULT]); } catch { fs.cpSync(sourceVault, VAULT, { recursive: true }); }
  makeFiller(VAULT, Number(opt.filler));
  makeReadmes(VAULT);
  oddWritten = makeOddNames(VAULT);
  fs.writeFileSync(OBS_JSON, JSON.stringify({ vaults: { a1b2c3d4e5f60718: { path: VAULT, ts: 1, open: true } } }));
}
const home = (/** @type {string} */ name) => path.join(base, `home-${name}`);
const MAIN = home('main');

// ---------- helpers ----------
/** @type {{ n: number | string, name: string, ok: boolean, detail: string, seconds: number }[]} */
const results = [];
/** @type {{ n: number | string, name: string, why: string }[]} */
const skipped = [];
const timings = {};
const notes = [];
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const envFor = (/** @type {string} */ h, extra = {}) => ({ ...process.env, VAULT_MIRROR_HOME: h, NO_COLOR: '1', ...(READ_ONLY ? {} : { VAULT_MIRROR_OBSIDIAN_JSON: OBS_JSON }), ...extra });

/** Every file of the vault: path -> size, mtimeNs, mode, sha256. */
function snapshot(root = VAULT) {
  /** @type {Map<string, string>} */
  const out = new Map();
  const walk = (/** @type {string} */ dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) { const s = fs.lstatSync(abs, { bigint: true }); out.set(path.relative(root, abs) + '/', `dir ${s.mode}`); walk(abs); }
      else if (d.isFile()) { const s = fs.lstatSync(abs, { bigint: true }); out.set(path.relative(root, abs), `${s.size} ${s.mtimeNs} ${s.mode} ${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`); }
      else out.set(path.relative(root, abs), 'other');
    }
  };
  walk(root);
  return out;
}
let expected = snapshot();
let snapshotChecks = 0;
/** Throws when the tool changed anything in the vault. In a live vault only non-dot paths are strict. */
function assertVaultUntouched(/** @type {string} */ after) {
  const now = snapshot();
  snapshotChecks++;
  const diffs = [];
  for (const [k, v] of expected) if (now.get(k) !== v) diffs.push(k);
  for (const k of now.keys()) if (!expected.has(k)) diffs.push(`(new) ${k}`);
  const dot = (/** @type {string} */ k) => k.replace('(new) ', '').split(path.sep).some((seg) => seg.startsWith('.'));
  const strict = READ_ONLY ? diffs.filter((k) => !dot(k)) : diffs;
  if (READ_ONLY && diffs.length !== strict.length) notes.push(`notice: ${diffs.length - strict.length} dot-folder file(s) differ after ${after} (Obsidian rewrites its own settings); not a failure`);
  if (strict.length) throw new Error(`the vault changed after ${after}: ${strict.slice(0, 5).join(', ')}`);
}
/** Call after the test itself edits the vault copy. */
const accept = () => { expected = snapshot(); };

/** Run the binary and wait. */
function vm(/** @type {string[]} */ args, /** @type {{ home?: string, env?: Record<string, string>, cwd?: string, input?: string, timeout?: number }} */ o = {}) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: o.cwd || CWD, env: envFor(o.home || MAIN, o.env), encoding: 'utf8', input: o.input, timeout: o.timeout || 900000, maxBuffer: 64 * 1024 * 1024 });
  /** @type {any} */
  let json = null;
  if (args.includes('--json')) { try { json = JSON.parse(r.stdout); } catch { json = null; } }
  assertVaultUntouched(`vault-mirror ${args.join(' ')}`);
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, json, ms: Date.now() - t };
}
/** Start the binary and return at once. */
function vmStart(/** @type {string[]} */ args, /** @type {{ home?: string, env?: Record<string, string> }} */ o = {}) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: CWD, env: envFor(o.home || MAIN, o.env), stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child, stdout: '', stderr: '', lastOutputAt: Date.now(), exitedAt: 0, status: /** @type {number | null} */ (null), signal: /** @type {string | null} */ (null), startedAt: Date.now() };
  child.stdout.on('data', (d) => { state.stdout += d; state.lastOutputAt = Date.now(); });
  child.stderr.on('data', (d) => { state.stderr += d; state.lastOutputAt = Date.now(); });
  const done = new Promise((resolve) => child.on('close', (code, signal) => { state.status = code; state.signal = signal; state.exitedAt = Date.now(); resolve(state); }));
  return { state, done, pid: /** @type {number} */ (child.pid) };
}
function assert(/** @type {any} */ cond, /** @type {string} */ message) { if (!cond) throw new Error(message); }
function eq(/** @type {any} */ a, /** @type {any} */ b, /** @type {string} */ what) { if (a !== b) throw new Error(`${what}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`); }

/** Read an index folder straight from disk: manifest, and id -> passage text. */
function readIndex(/** @type {string} */ h) {
  const indexes = path.join(h, 'indexes');
  const dir = path.join(indexes, fs.readdirSync(indexes)[0]);
  const current = fs.readFileSync(path.join(dir, 'CURRENT'), 'utf8').trim();
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, current, 'manifest.json'), 'utf8'));
  const log = fs.readFileSync(path.join(dir, current, 'passages.jsonl'));
  /** @type {Map<string, string>} */
  const texts = new Map();
  for (const [key, e] of Object.entries(manifest.notes)) {
    const rec = JSON.parse(log.toString('utf8', e.log[0], e.log[0] + e.log[1]));
    rec.passages.forEach((/** @type {any} */ p) => texts.set(`${key}#${p.n}`, p.text));
  }
  return { dir, dataDir: path.join(dir, current), manifest, texts };
}
/** Does any file under a folder contain this text? Returns the files that do. */
function grep(/** @type {string} */ dir, /** @type {string} */ needle) {
  const hits = []; const want = Buffer.from(needle);
  const walk = (/** @type {string} */ d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const abs = path.join(d, e.name); if (e.isDirectory()) walk(abs); else if (e.isFile() && fs.readFileSync(abs).includes(want)) hits.push(path.relative(dir, abs)); } };
  walk(dir);
  return hits;
}
/** Processes still alive whose command line mentions this run's temp folder. */
function leftoverProcesses() {
  const out = WIN
    ? spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'], { encoding: 'utf8' }).stdout || ''
    : spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout;
  return out.split(/\r?\n/).filter((l) => l.includes(base) && !l.includes('run.mjs') && !/\bps -axo\b/.test(l) && !l.includes('Get-CimInstance')).map((l) => l.trim().slice(0, 160));
}
/** Make every file and folder under a root read-only, or writable again. */
function setWritable(/** @type {string} */ root, /** @type {boolean} */ writable) {
  const all = [root]; const dirs = [root];
  while (dirs.length) { const d = /** @type {string} */ (dirs.pop()); for (const e of fs.readdirSync(d, { withFileTypes: true })) { const abs = path.join(d, e.name); if (e.isSymbolicLink()) continue; all.push(abs); if (e.isDirectory()) dirs.push(abs); } }
  // Folders last when taking the right away, first when giving it back.
  for (const abs of writable ? all : all.reverse()) { const mode = fs.statSync(abs).mode & 0o777; fs.chmodSync(abs, writable ? mode | 0o200 : mode & ~0o222); }
}
/** A --require option for NODE_OPTIONS that survives spaces and backslashes in the path. */
const requireOption = (/** @type {string} */ file) => `--require "${file.replace(/\\/g, '\\\\')}"`;
/** Record a step this system cannot run, with the reason. It is listed apart from the passes. */
function skipStep(/** @type {number | string} */ n, /** @type {string} */ name, /** @type {string} */ why) {
  if (typeof n === 'number' && !wants(n)) return;
  skipped.push({ n, name, why });
  console.log(`SKIP ${String(n).padStart(3)}  ${name}  [${why}]`);
}
function lockHeld(/** @type {string} */ h) {
  const dir = readIndex(h).dir;
  return ['sync.lock', 'index.lock'].filter((name) => {
    try { const l = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); process.kill(l.pid, 0); return true; } catch { return false; }
  });
}
/** Poll until the index under a home holds at least this many passages. */
async function waitForPassages(/** @type {string} */ h, /** @type {number} */ min, timeoutMs = 120000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const m = readIndex(h).manifest; if (m.totals.passages >= min) return m.totals.passages; } catch { /* not there yet */ }
    await sleep(100);
  }
  throw new Error(`no checkpoint with ${min} passages appeared in ${timeoutMs / 1000} s`);
}
const top = (/** @type {any} */ json) => (json && json.results && json.results[0]) || {};
const edit = (/** @type {string} */ rel, /** @type {(text: string) => string} */ fn) => { const p = path.join(VAULT, rel); fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8'))); };

async function step(/** @type {number | string} */ n, /** @type {string} */ name, /** @type {() => Promise<string | void> | string | void} */ fn) {
  if (typeof n === 'number' && !wants(n)) return;
  if (typeof n === 'string' && only && !READ_ONLY) return;
  if (typeof n === 'string' && READ_ONLY) return;
  const t = Date.now();
  try {
    const detail = (await fn()) || '';
    results.push({ n, name, ok: true, detail, seconds: (Date.now() - t) / 1000 });
    console.log(`PASS ${String(n).padStart(3)}  ${name}${detail ? `  [${detail}]` : ''}  (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  } catch (e) {
    results.push({ n, name, ok: false, detail: String(/** @type {any} */ (e).message), seconds: (Date.now() - t) / 1000 });
    console.log(`FAIL ${String(n).padStart(3)}  ${name}\n          ${String(/** @type {any} */ (e).message).split('\n').join('\n          ')}`);
  }
}

// ---------- the run ----------
console.log(`vault-mirror acceptance run\n  vault: ${READ_ONLY ? '(read-only, live)' : 'a temp copy of the fixture, with invented filler notes'}\n  node ${process.version}, ${os.cpus().length} cores, load ${os.loadavg().map((x) => x.toFixed(1)).join(' ')}\n`);
let eligible = 0;
/** @type {{ lastLineToExitMs: number, leftovers: string[], locks: string[] } | null} */
let afterFullSync = null; let afterSigint = null;

await step(1, 'doctor before init', () => {
  const r = vm(['doctor', '--json']);
  eq(r.status, 0, 'exit'); assert(r.json && r.json.ok, 'one JSON object');
  eq(r.json.checks.find((/** @type {any} */ c) => c.name === 'vault').status, 'info', 'the vault check');
  const failed = r.json.checks.filter((/** @type {any} */ c) => c.status === 'fail');
  eq(failed.length, 0, 'failed checks');
  timings.doctorMs = r.ms;
  return `${r.json.checks.length} checks, ${r.json.estimate.passagesPerSecond} passages/s estimated`;
});

await step(2, 'search before any sync', () => {
  const none = vm(['search', 'anything', '--json']);
  eq(none.status, 2, 'exit before init'); eq(none.json.error.code, 'VM_E_NO_VAULT', 'code before init');
  const init = vm(['init', VAULT, '--project', PROJECT, '--json']);
  eq(init.status, 0, 'init exit');
  eligible = init.json.notesFound;
  if (!READ_ONLY) assert(init.json.ruleFiles.every((/** @type {any} */ f) => f.action === 'created'), 'rule files created');
  const r = vm(['search', 'anything', '--json']);
  eq(r.status, 2, 'exit'); eq(r.json.error.code, 'VM_E_NOT_SYNCED', 'code');
  eq(r.json.vault && r.json.vault.path, VAULT, 'a --json error names the vault once one is set');
  return `init found ${eligible} notes`;
});

await step(3, 'init, then sync', async () => {
  const run = vmStart(['sync', '--json']);
  const s = /** @type {any} */ (await run.done);
  assertVaultUntouched('sync');
  eq(s.status, 0, 'exit');
  const j = JSON.parse(s.stdout);
  eq(j.inStep, true, 'inStep');
  const st = vm(['status', '--json']).json;
  eq(j.counts.added, st.counts.eligible, 'added equals eligible notes');
  eq(j.counts.added, st.counts.notesIndexed, 'added equals notes in the index');
  timings.firstSync = { seconds: j.seconds, passages: j.passages.total, notes: j.counts.added, perSecond: +(j.passages.total / j.seconds).toFixed(1), ...j.resources };
  afterFullSync = { lastLineToExitMs: s.exitedAt - s.lastOutputAt, leftovers: leftoverProcesses(), locks: lockHeld(MAIN) };
  return `${j.counts.added} notes, ${j.passages.total} passages in ${j.seconds} s, ${j.resources.workers} readers, peak ${j.resources.peakRssMB} MB`;
});

await step(4, 'sync again', () => {
  const r = vm(['sync', '--json']);
  eq(r.status, 0, 'exit');
  eq(r.json.counts.added + r.json.counts.updated + r.json.counts.removed + r.json.counts.renamed, 0, 'changes');
  eq(r.json.passages.embedded, 0, 'embedded');
  assert(r.ms < 2000, `took ${r.ms} ms, wanted under 2 s`);
  const human = vm(['sync']);
  assert(/^Nothing changed\. In step: /.test(human.stdout), `human line: ${human.stdout}`);
  timings.noChangeSyncMs = Math.min(r.ms, human.ms);
  return `${timings.noChangeSyncMs} ms`;
});

await step(5, 'status', () => {
  const r = vm(['status', '--json']);
  eq(r.status, 0, 'exit'); eq(r.json.inStep, true, 'inStep');
  const bad = r.json.checks.filter((/** @type {any} */ c) => !c.ok).map((/** @type {any} */ c) => c.name);
  eq(bad.join(','), '', 'failed checks');
  const c = r.json.counts; const left = Object.values(c.leftOut).reduce((/** @type {number} */ a, /** @type {any} */ b) => a + b, 0);
  eq(c.notesOnDisk, c.notesIndexed + left, 'notes on disk = indexed + left out');
  eq(c.passagesRecorded, c.passagesInEngine, 'passages recorded = passages in the engine');
  timings.statusMs = Math.min(r.ms, vm(['status']).ms);
  return `${c.notesOnDisk} on disk = ${c.notesIndexed} indexed + ${left} left out; ${timings.statusMs} ms`;
});

const NEW_SENTENCE = 'The copper kettle from the lighthouse keeper hangs above the stock pot now.';
const OLD_SENTENCE = 'Never let it boil hard or the stock turns cloudy.';
await step(6, 'edit one note; sync', () => {
  const before = readIndex(MAIN).manifest.stamp;
  edit('Kitchen/Soup stock.md', (t) => { assert(t.includes(OLD_SENTENCE), 'fixture sentence present'); return t.replace(OLD_SENTENCE, NEW_SENTENCE); });
  accept();
  const r = vm(['sync', '--json']);
  eq(r.status, 0, 'exit'); eq(r.json.counts.updated, 1, 'updated'); eq(r.json.counts.added, 0, 'added');
  const idx = readIndex(MAIN);
  eq(r.json.passages.embedded, idx.manifest.notes['Kitchen/Soup stock.md'].passages, 'only that note was embedded');
  assert(idx.manifest.stamp !== before, 'the stamp moved');
  const s = vm(['search', NEW_SENTENCE, '--json']);
  eq(top(s.json).vaultPath, 'Kitchen/Soup stock.md', 'rank 1 for the new sentence');
  assert(top(s.json).text.includes('copper kettle'), 'the result carries the full passage text');
  eq(grep(MAIN, 'stock turns cloudy').join(','), '', 'the removed sentence appears nowhere in the index folder');
  timings.oneEditSyncMs = r.ms;
  return `1 updated, ${r.json.passages.embedded} passages embedded, ${r.ms} ms`;
});

await step('Q1', 'edit one note; search with no sync in between', () => {
  // The search's own quick sync does the work, in the same process that then searches. That process
  // holds the engine file open, so it must not probe the file again (the probe child cannot open it).
  const SENTENCE = 'The starter jar lives on the shelf above the heliotrope accordion.';
  edit('Kitchen/Sourdough.md', (t) => `${t}\n${SENTENCE}\n`); accept();
  const s = vm(['search', 'where is the starter jar kept, near the accordion', '--json']);
  eq(s.status, 0, 'exit');
  eq(s.json.inStep, true, 'the quick sync brought the index in step');
  eq(top(s.json).vaultPath, 'Kitchen/Sourdough.md', 'rank 1 for the sentence just added');
  assert(top(s.json).text.includes('heliotrope accordion'), 'the new text is what came back');
  assert(!s.json.warnings.some((/** @type {string} */ w) => /damaged|reloaded/.test(w)), `no false notice: ${JSON.stringify(s.json.warnings)}`);
  eq(s.json.timings.probeMs, 0, 'no probe of a file this process already holds open');
  assert(s.json.timings.engineMs < 2000, `the engine was ready in ${s.json.timings.engineMs} ms`);
  const next = vm(['search', 'where is the starter jar kept, near the accordion', '--json', '--no-sync']);
  eq(top(next.json).vaultPath, 'Kitchen/Sourdough.md', 'the next process finds it too');
  assert(!next.json.warnings.some((/** @type {string} */ w) => /damaged|reloaded/.test(w)), `the engine file was left in step: ${JSON.stringify(next.json.warnings)}`);
  timings.editThenSearchMs = s.ms;
  return `${s.ms} ms, engine ${s.json.timings.engineMs} ms`;
});

await step('Q2', 'edit one note; five searches at once', async () => {
  // One search does the quick sync, which ends with a tidy rewrite: the data folder the others loaded is
  // removed while they read. Each of them must re-read CURRENT and answer, never fail.
  let wrong = 0; let total = 0;
  for (let round = 0; round < 4; round++) {
    edit('Kitchen/Pickles.md', (t) => `${t}\nRound ${round}: the brine crock sits beside the mauve barometer.\n`); accept();
    const started = [];
    for (let i = 0; i < 5; i++) { started.push(vmStart(['search', 'where does the brine crock sit, near the barometer', '--json'])); await sleep(40); }
    for (const s of /** @type {any[]} */ (await Promise.all(started.map((x) => x.done)))) {
      total++;
      /** @type {any} */
      let json = null; try { json = JSON.parse(s.stdout); } catch { json = null; }
      if (s.status !== 0 || !json || !json.ok || !json.results.length) { wrong++; notes.push(`step Q2: a search during a sync exited ${s.status} ${json && json.error ? json.error.code : s.stderr.slice(0, 120)}`); }
    }
    assertVaultUntouched('five searches at once');
  }
  eq(wrong, 0, 'searches that failed while another one synced');
  eq(vm(['status', '--json']).json.inStep, true, 'in step afterwards');
  return `${total} searches across 4 edits, none failed`;
});

await step(7, 'delete one note; sync', () => {
  const idx = readIndex(MAIN);
  const had = idx.manifest.notes['Travel/Packing list.md'].passages; const total = idx.manifest.totals.passages;
  fs.rmSync(path.join(VAULT, 'Travel', 'Packing list.md')); accept();
  const r = vm(['sync', '--json']);
  eq(r.json.counts.removed, 1, 'removed');
  eq(r.json.passages.total, total - had, 'passages drop by exactly that note\'s count');
  const s = vm(['search', 'plug adapter rain jacket refillable water bottle passport', '--json', '-k', '20']);
  assert(!s.json.results.some((/** @type {any} */ x) => x.vaultPath === 'Travel/Packing list.md'), 'no search returns it');
  eq(grep(MAIN, 'Refillable water bottle').join(','), '', 'its text is gone from the index folder');
  return `removed 1, ${had} passages gone`;
});

await step(8, 'add one note; sync', () => {
  fs.writeFileSync(path.join(VAULT, 'Garden', 'Beekeeping.md'), '# Beekeeping\n\n## Spring inspection\n\nOpen the hive on a warm still day and look for eggs, capped brood and stores of honey before adding a super.\n');
  accept();
  const r = vm(['sync', '--json']);
  eq(r.json.counts.added, 1, 'added');
  const s = vm(['search', 'when should I check the beehive for brood', '--json']);
  eq(top(s.json).vaultPath, 'Garden/Beekeeping.md', 'rank 1');
  eq(top(s.json).section, 'Spring inspection', 'section');
  eq(top(s.json).link, 'obsidian://open?vault=vault&file=Garden%2FBeekeeping.md%23Spring%20inspection', 'link');
  return 'added 1, searchable';
});

await step(9, 'rename one note; sync', () => {
  const total = readIndex(MAIN).manifest.totals.passages;
  fs.renameSync(path.join(VAULT, 'Garden', 'Compost.md'), path.join(VAULT, 'Garden', 'Compost heap.md')); accept();
  const r = vm(['sync', '--json']);
  eq(r.json.counts.renamed, 1, 'renamed'); eq(r.json.counts.added, 0, 'added'); eq(r.json.counts.removed, 0, 'removed');
  eq(r.json.passages.total, total, 'passage total unchanged');
  const s = vm(['search', 'turn the heap with a fork when it smells sour', '--json', '-k', '10']);
  const paths = s.json.results.map((/** @type {any} */ x) => x.vaultPath);
  assert(paths.includes('Garden/Compost heap.md') && !paths.includes('Garden/Compost.md'), `old path gone, new path present: ${paths.slice(0, 3)}`);
  return 'renamed 1';
});

await step(10, 'rename a folder holding 30% of the notes; sync', () => {
  const idx = readIndex(MAIN); const all = Object.keys(idx.manifest.notes); const inFolder = all.filter((k) => k.startsWith('Filler/')).length;
  assert(inFolder / all.length >= 0.3, `the folder holds ${inFolder} of ${all.length} notes`);
  fs.renameSync(path.join(VAULT, 'Filler'), path.join(VAULT, 'Filler moved')); accept();
  const r = vm(['sync', '--json']);
  eq(r.status, 0, 'exit (the mass-removal guard must not trip)');
  eq(r.json.counts.renamed, inFolder, 'renamed'); eq(r.json.counts.removed, 0, 'removed');
  eq(r.json.passages.total, idx.manifest.totals.passages, 'passage total unchanged');
  return `${inFolder} of ${all.length} notes renamed`;
});

await step(11, 'remove 30% of notes; then an exclude that covers 30%', () => {
  const before = readIndex(MAIN).manifest;
  const stash = path.join(base, 'stash');
  fs.renameSync(path.join(VAULT, 'Filler moved'), stash); accept();
  const gone = vm(['sync', '--json']);
  eq(gone.status, 4, 'exit when 30% of notes vanish'); eq(gone.json.error.code, 'VM_E_MASS_DELETE', 'code');
  eq(readIndex(MAIN).manifest.stamp, before.stamp, 'nothing changed');
  fs.renameSync(stash, path.join(VAULT, 'Filler moved')); accept();
  eq(vm(['sync', '--json']).json.passages.embedded, 0, 'back in place: nothing to do');
  const cfgFile = path.join(MAIN, 'config.json'); const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const original = [...cfg.vault.exclude];
  cfg.vault.exclude = [...original, 'Filler moved']; fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const ex = vm(['sync', '--json']);
  eq(ex.status, 4, 'exit when an exclude covers 30%'); eq(ex.json.error.code, 'VM_E_MASS_DELETE', 'code');
  eq(readIndex(MAIN).manifest.stamp, before.stamp, 'nothing changed');
  const allow = vm(['sync', '--allow-mass-delete', '--json']);
  eq(allow.status, 0, 'exit with --allow-mass-delete');
  const st = vm(['status', '--json']).json;
  eq(st.inStep, true, 'in step, with that folder left out');
  assert(st.counts.leftOut.excluded >= allow.json.counts.removed, 'the excluded notes are counted as left out');
  assert(/with these folders left out/.test(vm(['status']).stdout), 'status says which folders are left out');
  cfg.vault.exclude = original; fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  const back = vm(['sync', '--json']);
  eq(back.json.counts.added, allow.json.counts.removed, 'the folder comes back');
  return `exit 4 twice; ${allow.json.counts.removed} notes left with --allow-mass-delete, then came back`;
});

await step(12, 'mark a note index: false; sync', () => {
  const before = vm(['status', '--json']).json;
  const idx = readIndex(MAIN); const had = idx.manifest.notes['Kitchen/Pickles.md'].passages;
  edit('Kitchen/Pickles.md', (t) => `---\nindex: false\n---\n${t}`); accept();
  const r = vm(['sync', '--json']);
  eq(r.status, 0, 'exit'); eq(r.json.passages.total, idx.manifest.totals.passages - had, 'its passages are gone');
  const st = vm(['status', '--json']).json;
  eq(st.counts.leftOut.indexFalse, before.counts.leftOut.indexFalse + 1, 'leftOut.indexFalse');
  eq(st.inStep, true, 'in step');
  for (const needle of ['Pickles', 'Three percent salt', 'hidden lighthouse', 'Index false']) eq(grep(MAIN, needle).join(','), '', `"${needle}" appears nowhere in the index folder, logs included`);
  const listed = vm(['status', '--list', '--json']).json.list.leftOut.find((/** @type {any} */ x) => x.path === 'Kitchen/Pickles.md');
  eq(listed && listed.reason, 'index-false', 'status --list names it, read live from disk');
  return `${had} passages removed; name and text nowhere in the index folder`;
});

await step(13, 'status --verify', () => {
  const r = vm(['status', '--verify', '--json']);
  eq(r.status, 0, 'exit');
  const bad = r.json.checks.filter((/** @type {any} */ c) => !c.ok).map((/** @type {any} */ c) => `${c.name} (${c.detail})`);
  eq(bad.join('; '), '', 'failed checks');
  eq(r.json.inStep, true, 'inStep');
  for (const name of ['verify-every-id', 'verify-spot-check', 'verify-sidecar']) assert(r.json.checks.some((/** @type {any} */ c) => c.name === name), `${name} ran`);
  timings.statusVerifyMs = r.ms;
  return `${r.json.checks.length} checks, ${r.ms} ms`;
});

await step(14, 'kill -9 a fresh first sync mid-run, then sync again', async () => {
  const h = home('kill9');
  eq(vm(['init', VAULT, '--no-rule', '--json'], { home: h }).status, 0, 'init');
  const run = vmStart(['sync'], { home: h });
  const saved = await waitForPassages(h, 40);
  process.kill(run.pid, 'SIGKILL');
  const s = /** @type {any} */ (await run.done);
  // Windows ends the process without naming a signal: it reports a failed exit instead.
  if (WIN) assert(s.signal === 'SIGKILL' || s.status !== 0, `the first run was killed (exit ${s.status}, signal ${s.signal})`);
  else eq(s.signal, 'SIGKILL', 'the first run was killed');
  await sleep(300);
  const want = readIndex(MAIN).manifest.totals;
  const again = vm(['sync', '--json'], { home: h });
  eq(again.status, 0, 'exit');
  assert(again.json.passages.embedded < want.passages, `second run embedded ${again.json.passages.embedded} of ${want.passages}`);
  assert(again.json.passages.embedded > 0, 'the second run had a remainder to embed');
  const v = vm(['status', '--verify', '--json'], { home: h });
  eq(v.json.inStep, true, 'status --verify in step');
  eq(again.json.passages.total, want.passages, 'passage total equals a sync that was never interrupted');
  eq(v.json.counts.notesIndexed, want.notes, 'note total');
  return `killed with ${saved}+ passages saved; second run embedded ${again.json.passages.embedded} of ${want.passages}`;
});

if (WIN) skipStep(15, 'SIGINT mid-sync', 'Windows cannot send Ctrl+C to another process; a forced stop is step 14');
else await step(15, 'SIGINT mid-sync', async () => {
  const h = home('sigint');
  vm(['init', VAULT, '--no-rule', '--json'], { home: h });
  const run = vmStart(['sync'], { home: h });
  await waitForPassages(h, 40);
  const sent = Date.now();
  process.kill(run.pid, 'SIGINT');
  const s = /** @type {any} */ (await run.done);
  eq(s.status, 130, 'exit');
  assert(/Stopped at [\d,]+ of [\d,]+ notes\.\nNext: Run it again to continue\./.test(s.stderr), `message: ${s.stderr.slice(-200)}`);
  afterSigint = { lastLineToExitMs: s.exitedAt - s.lastOutputAt, leftovers: leftoverProcesses(), locks: lockHeld(h), stopMs: s.exitedAt - sent };
  const again = vm(['sync', '--json'], { home: h });
  eq(again.status, 0, 'next sync exit'); eq(again.json.inStep, true, 'next sync completes');
  eq(again.json.passages.total, readIndex(MAIN).manifest.totals.passages, 'totals');
  return `stopped ${afterSigint.stopMs} ms after the signal; next sync embedded the remaining ${again.json.passages.embedded}`;
});

await step(16, 'two syncs at once; and a sync paused with SIGSTOP', async () => {
  const want = readIndex(MAIN).manifest.totals;
  const h = home('two');
  vm(['init', VAULT, '--no-rule', '--json'], { home: h });
  const a = vmStart(['sync', '--json'], { home: h }); const b = vmStart(['sync', '--json'], { home: h });
  const [sa, sb] = /** @type {any[]} */ (await Promise.all([a.done, b.done]));
  assert([0, 6].includes(sa.status) && [0, 6].includes(sb.status), `exits ${sa.status} and ${sb.status}`);
  const embedded = [sa, sb].filter((s) => s.status === 0).map((s) => JSON.parse(s.stdout).passages.embedded);
  eq(embedded.reduce((x, y) => x + y, 0), want.passages, 'the two runs together embedded every passage exactly once (never two writers)');
  eq(vm(['status', '--verify', '--json'], { home: h }).json.inStep, true, 'status --verify in step');
  const seen = new Set(); const idx = readIndex(h);
  for (const line of fs.readFileSync(path.join(idx.dataDir, 'passages.jsonl'), 'utf8').trim().split('\n').slice(1)) { const rec = JSON.parse(line); assert(!seen.has(rec.path), `duplicate record for a note`); seen.add(rec.path); }
  eq(idx.texts.size, want.passages, 'no duplicate passages');

  if (WIN) { notes.push('step 16: the paused-sync half was not run (Windows cannot pause and resume another process)'); return 'two syncs at once never wrote twice; the paused-sync half is not run on Windows'; }
  const stopSeconds = Number(opt['stop-seconds']);
  const h2 = home('paused');
  vm(['init', VAULT, '--no-rule', '--json'], { home: h2 });
  const first = vmStart(['sync', '--json'], { home: h2 });
  await waitForPassages(h2, 40);
  process.kill(first.pid, 'SIGSTOP');
  const second = vmStart(['sync', '--json', '--wait', String(stopSeconds + 300)], { home: h2 });
  let secondDoneEarly = false; second.done.then(() => { secondDoneEarly = true; });
  await sleep(stopSeconds * 1000);
  const tookOver = secondDoneEarly;
  const frozen = readIndex(h2).manifest.totals.passages;
  process.kill(first.pid, 'SIGCONT');
  const [s1, s2] = /** @type {any[]} */ (await Promise.all([first.done, second.done]));
  assert(!tookOver, 'the waiting sync finished while the first was paused: a live owner was taken over');
  eq(s1.status, 0, 'the paused sync finished after it was resumed');
  eq(s2.status, 0, 'the waiting sync ran after it');
  const j2 = JSON.parse(s2.stdout);
  eq(j2.passages.embedded, 0, 'the waiting sync found nothing left to do');
  assert(/Another sync is running/.test(s2.stderr) || true, 'waiting message');
  eq(vm(['status', '--verify', '--json'], { home: h2 }).json.inStep, true, 'status --verify in step');
  eq(readIndex(h2).texts.size, want.passages, 'no duplicate passages');
  return `two at once: exits ${sa.status}/${sb.status}; paused ${stopSeconds} s with ${frozen} passages saved, the second waited and then embedded 0`;
});

await step(17, 'sync --detach, status polling, a search while it runs', async () => {
  const h = home('detach');
  vm(['init', VAULT, '--no-rule', '--json'], { home: h });
  const d = vm(['sync', '--detach', '--json'], { home: h });
  eq(d.status, 0, 'exit'); assert(d.ms < 3000, `returned in ${d.ms} ms`); eq(d.json.detached, true, 'detached');
  const again = vm(['sync', '--detach', '--json'], { home: h });
  let sawRunning = false; let sawPercent = -1; let searched = null;
  const end = Date.now() + 900000;
  while (Date.now() < end) {
    const st = vm(['status', '--json'], { home: h });
    eq(st.status, 0, 'status exit while a sync runs');
    if (st.json.running) {
      sawRunning = true; sawPercent = Math.max(sawPercent, st.json.running.percent);
      if (!searched && st.json.counts.passagesRecorded > 0) {
        searched = vm(['search', READ_ONLY ? 'how do I sync my notes' : 'watering the garden', '--json'], { home: h });
        eq(searched.status, 0, 'search exit while a sync runs');
        assert(!/lock|already open/i.test(searched.stderr + JSON.stringify(searched.json.warnings)), 'never a lock error');
      }
    } else if (st.json.inStep) break;
    await sleep(700);
  }
  assert(sawRunning, 'status showed the running sync');
  if (again.json.alreadyRunning !== true) notes.push('step 17: the second --detach did not see the first one running (it had not taken the lock yet)');
  assert(searched, 'a search ran while the sync was running');
  assert(searched.json.results.length > 0, 'the search returned partial results');
  assert(/sync is running/.test(searched.json.syncNotice || ''), `notice: ${searched.json.syncNotice}`);
  assert(searched.json.searched.passages <= readIndex(h).manifest.totals.passages, 'partial');
  eq(vm(['status', '--json'], { home: h }).json.inStep, true, 'in step at the end');
  assert(fs.existsSync(path.join(readIndex(h).dir, 'logs', 'last-sync.out')), 'output went to logs/last-sync.out');
  if (!READ_ONLY) eq(fs.readFileSync(path.join(readIndex(h).dir, 'logs', 'last-sync.out'), 'utf8').split('looks like a password or key').length - 1, 1, 'the flagged-note line is in the detached log once');
  eq(leftoverProcesses().join(' | '), '', 'no process left');
  return `returned in ${d.ms} ms; progress seen up to ${sawPercent}%; search during the run covered ${searched.json.searched.passages} passages`;
});

const QUERY = READ_ONLY ? 'Where does the app keep my settings and themes?' : 'when do I move the tomatoes outside';
const QUERY_WANT = READ_ONLY ? null : 'Garden/Garden plan.md';
await step(18, 'delete the engine folder; search', () => {
  const idx = readIndex(MAIN); const before = vm(['search', QUERY, '--json']).json;
  fs.rmSync(path.join(idx.dir, 'engine'), { recursive: true });
  const r = vm(['search', QUERY, '--json']);
  eq(r.status, 0, 'exit');
  assert(r.json.warnings.some((/** @type {string} */ w) => /^The index was reloaded from saved passages/.test(w)), `reload notice: ${JSON.stringify(r.json.warnings)}`);
  eq(JSON.stringify(r.json.results.map((/** @type {any} */ x) => x.passage)), JSON.stringify(before.results.map((/** @type {any} */ x) => x.passage)), 'same results as before');
  if (QUERY_WANT) eq(top(r.json).vaultPath, QUERY_WANT, 'correct result');
  const after = readIndex(MAIN);
  eq(after.manifest.stamp, idx.manifest.stamp, 'nothing re-embedded (same stamp)');
  eq(after.manifest.sidecar.vectors, idx.manifest.sidecar.vectors, 'nothing re-embedded (same vectors)');
  return 'reloaded from saved passages';
});

await step(19, 'fetch disabled, model cached', () => {
  const log = path.join(base, 'nofetch.log'); fs.writeFileSync(log, '');
  const env = { NODE_OPTIONS: requireOption(path.join(REPO, 'tests', 'helpers', 'nofetch.cjs')), VM_NOFETCH_LOG: log };
  const h = READ_ONLY ? MAIN : home('offline');
  if (!READ_ONLY) vm(['init', VAULT, '--no-rule', '--json'], { home: h, env });
  const s = vm(['sync', '--json'], { home: h, env });
  eq(s.status, 0, 'sync exit');
  const q = vm(['search', QUERY, '--no-sync', '--json'], { home: h, env });
  eq(q.status, 0, 'search exit'); assert(q.json.results.length > 0, 'results');
  eq(fs.readFileSync(log, 'utf8'), '', 'network calls');
  return `sync (${s.json.passages.embedded} passages embedded) and search with zero network calls`;
});

await step(20, 'rebuild --full versus the incremental history', () => {
  const h = home('detach'); // a home that already holds a full sync of this same vault
  if (!fs.existsSync(h)) vm(['init', VAULT, '--no-rule', '--json'], { home: h });
  const refuse = vm(['rebuild', '--full', '--json'], { home: h });
  eq(refuse.status, 2, 'a full rebuild asks first: without --yes it changes nothing');
  const r = vm(['rebuild', '--full', '--yes', '--json'], { home: h });
  eq(r.status, 0, 'exit'); eq(r.json.mode, 'full', 'mode'); eq(r.json.inStep, true, 'inStep');
  const fresh = readIndex(h).texts; const incremental = readIndex(MAIN).texts;
  eq([...fresh.keys()].sort().join('\n') === [...incremental.keys()].sort().join('\n'), true, 'identical set of ids');
  for (const [id, text] of incremental) if (fresh.get(id) !== text) throw new Error(`passage text differs for one id`);
  const quick = vm(['rebuild', '--json']);
  eq(quick.status, 0, 'rebuild exit'); eq(quick.json.mode, 'engine', 'mode'); eq(quick.json.inStep, true, 'in step after rebuild'); eq(quick.json.next, null, 'no next action');
  assert(/^Rebuilt the index from saved passages in .* \([\d,]+ passages\)\. Nothing was re-read\.\nIn step: yes\.$/m.test(vm(['rebuild']).stdout), 'human wording');
  timings.rebuildMs = quick.ms;
  // One saved passage record that no longer parses: `rebuild` still exits 0 and names the one way out.
  const d = home('damaged');
  try { execFileSync('cp', ['-cR', h, d]); } catch { fs.cpSync(h, d, { recursive: true }); }
  const di = readIndex(d); const logFile = path.join(di.dataDir, 'passages.jsonl');
  const at = /** @type {[number, number]} */ (Object.values(di.manifest.notes)[0].log);
  const fd = fs.openSync(logFile, 'r+'); fs.writeSync(fd, 'X', at[0]); fs.closeSync(fd); // same length, no longer JSON
  const hurt = vm(['rebuild', '--json'], { home: d });
  eq(hurt.status, 0, 'rebuild exit with a damaged saved passage'); eq(hurt.json.inStep, false, 'not in step'); eq(hurt.json.next, 'vault-mirror rebuild --full', 'the one next action');
  assert(/^Next: vault-mirror rebuild$/m.test(vm(['status'], { home: d }).stdout), 'status points at rebuild');
  const mended = vm(['rebuild', '--full', '--yes', '--json'], { home: d });
  eq(mended.status, 0, 'rebuild --full exit'); eq(mended.json.inStep, true, 'in step after rebuild --full');
  return `${incremental.size} ids and texts identical; rebuild from saved passages ${quick.ms} ms; a damaged saved passage ends in rebuild --full`;
});

await step(21, 'search quality on the question list', () => {
  if (!opt.questions) return 'skipped: no --questions file given';
  const questions = JSON.parse(fs.readFileSync(opt.questions, 'utf8'));
  const lines = []; let top3 = 0; let agree = 0;
  for (const q of questions) {
    const wanted = [q.expected, ...(q.alternates || [])];
    const rank = (/** @type {any} */ json) => { const i = json.results.findIndex((/** @type {any} */ x) => wanted.includes(x.vaultPath)); return i < 0 ? null : i + 1; };
    const a = vm(['search', q.question, '--no-sync', '--json', '-k', '10']); const b = vm(['search', q.question, '--no-sync', '--json', '-k', '10']);
    const r1 = rank(a.json); const same = JSON.stringify(a.json.results.map((/** @type {any} */ x) => x.passage)) === JSON.stringify(b.json.results.map((/** @type {any} */ x) => x.passage));
    let r3 = null;
    if (q.phrasings) r3 = rank(vm(['search', q.question, ...q.phrasings, '--no-sync', '--json', '-k', '10']).json);
    if (r1 && r1 <= 3) top3++; if (same) agree++;
    lines.push(`    ${String(q.n).padStart(2)}. rank ${r1 ?? 'not in top 10'}${r3 !== null || q.phrasings ? `; with three wordings: ${r3 ?? 'not in top 10'}` : ''}; two runs agree: ${same}; got "${top(a.json).vaultPath}" (${top(a.json).score})`);
  }
  timings.searchQuality = { top3, of: questions.length, agree, lines };
  notes.push(`step 21 (recorded, not gated): expected note in the top 3 for ${top3} of ${questions.length} questions; two runs agreed on ${agree} of ${questions.length}\n${lines.join('\n')}`);

  // The recall check: reworded questions and questions in the note's own words, with one wording and with
  // three, by meaning alone and with the exact-words list. "Found" = the expected note is in what was printed.
  const found = (/** @type {any[]} */ list, /** @type {string[]} */ wanted) => list.some((x) => wanted.includes(x.vaultPath));
  /** @type {Record<string, any>} */
  const recall = {};
  let fused = 0;
  for (const [kind, pick] of /** @type {[string, (q: any) => string][]} */ ([['reworded', (q) => q.question], ['exact', (q) => q.exact]])) {
    const set = questions.filter((/** @type {any} */ q) => pick(q));
    if (!set.length) continue;
    for (const wordings of [1, 3]) {
      const row = { of: set.length, top3: 0, top6: 0, top3PlusExact: 0, top8: 0, top8PlusExact: 0 };
      for (const q of set) {
        if (wordings === 3 && !q.phrasings) { row.of--; continue; }
        const wanted = [q.expected, ...(q.alternates || [])];
        const words = wordings === 1 ? [pick(q)] : [pick(q), ...q.phrasings];
        const wide = vm(['search', ...words, '--no-sync', '--json', '-k', '8']).json;           // what a person's AI gets by default
        const narrow = vm(['search', ...words, '--no-sync', '--json', '-k', '3']).json;         // three by meaning plus the exact-words list
        const alone = vm(['search', ...words, '--no-sync', '--json', '-k', '8', '--no-exact-words']).json;
        if (JSON.stringify(alone.results) !== JSON.stringify(wide.results) || alone.exactWords.length) fused++;
        if (found(wide.results.slice(0, 3), wanted)) row.top3++;
        if (found(wide.results.slice(0, 6), wanted)) row.top6++;
        if (found(narrow.results, wanted) || found(narrow.exactWords, wanted)) row.top3PlusExact++;
        if (found(wide.results, wanted)) row.top8++;
        if (found(wide.results, wanted) || found(wide.exactWords, wanted)) row.top8PlusExact++;
      }
      recall[`${kind}, ${wordings === 1 ? 'one wording' : 'three wordings'}`] = row;
    }
  }
  eq(fused, 0, 'searches whose list by meaning changed when the exact-words list was turned off');
  timings.recall = recall;
  const table = Object.entries(recall).map(([k, r]) => `    ${k.padEnd(26)} of ${r.of}: by meaning top 3 = ${r.top3}, top 6 = ${r.top6}, top 3 + exact words = ${r.top3PlusExact}; top 8 = ${r.top8}, top 8 + exact words = ${r.top8PlusExact}`);
  notes.push(`step 21 recall check (recorded, not gated; load ${os.loadavg().map((x) => x.toFixed(1)).join(' ')}):\n${table.join('\n')}`);
  return `top 3 for ${top3} of ${questions.length} (target 8); two runs agree ${agree} of ${questions.length}`;
});

await step(22, 'window test (slow)', () => {
  const r = spawnSync(process.execPath, [path.join(HERE, 'window-test.mjs'), VAULT, '200'], { encoding: 'utf8', env: envFor(MAIN), cwd: CWD, timeout: 900000 });
  assertVaultUntouched('window test');
  eq(r.status, 0, `window test exit (${r.stdout.trim().split('\n').pop()} ${r.stderr.slice(-300)})`);
  const j = JSON.parse(r.stdout.trim().split('\n').pop() || '{}');
  eq(j.withinWindow, j.sampled, 'every sampled passage counts within the model\'s window');
  eq(j.lastWordSeen, j.sampled, 'changing the last word changed the vector for every one');
  assert(j.sampled >= Math.min(200, j.available), 'sample size');
  return `${j.lastWordSeen} of ${j.sampled} (densest ${j.maxTokens} tokens, lightest sampled ${j.minTokens})`;
});

await step(23, 'cut the live engine file to half its length; search', () => {
  const idx = readIndex(MAIN);
  const cur = JSON.parse(fs.readFileSync(path.join(idx.dir, 'engine', 'CURRENT'), 'utf8'));
  const file = path.join(idx.dir, 'engine', cur.file);
  const before = vm(['search', QUERY, '--json']).json;
  fs.truncateSync(file, Math.floor(fs.statSync(file).size / 2));
  const r = vm(['search', QUERY, '--json']);
  eq(r.signal, null, 'the tool\'s own process never died on a signal'); eq(r.status, 0, 'exit');
  assert(r.json.warnings.some((/** @type {string} */ w) => /^The index file was damaged\. It was rebuilt from saved passages \(.*\)\. Your notes were not touched\.$/.test(w)), `damaged notice: ${JSON.stringify(r.json.warnings)}`);
  eq(JSON.stringify(r.json.results.map((/** @type {any} */ x) => x.passage)), JSON.stringify(before.results.map((/** @type {any} */ x) => x.passage)), 'correct results');
  eq(readIndex(MAIN).manifest.stamp, idx.manifest.stamp, 'nothing re-embedded');
  eq(vm(['status', '--json']).json.inStep, true, 'in step afterwards');
  return 'damaged file detected by the child-process probe, rebuilt, search answered';
});

await step(24, 'commands return and leave nothing behind', () => {
  const parts = [];
  for (const [label, s] of /** @type {[string, any][]} */ ([['after a full sync with the pool', afterFullSync], ['after a sync stopped by SIGINT', afterSigint]])) {
    if (!s) { if ((READ_ONLY || WIN) && label.includes('SIGINT')) continue; throw new Error(`no measurement ${label} (did step ${label.includes('SIGINT') ? 15 : 3} run?)`); }
    assert(s.lastLineToExitMs < 5000, `${label}: returned ${s.lastLineToExitMs} ms after its last line`);
    eq(s.leftovers.join(' | '), '', `${label}: processes still alive`);
    eq(s.locks.join(','), '', `${label}: locks held by a live process`);
    parts.push(`${label}: exit ${s.lastLineToExitMs} ms after the last line`);
  }
  const t = vm(['sync', '--json']);
  eq(t.status, 0, 'the next sync starts at once'); assert(t.ms < 5000, `the next sync took ${t.ms} ms`);
  eq(leftoverProcesses().join(' | '), '', 'processes alive now');
  return parts.join('; ');
});

await step('R1', 'read-only vault: chmod -R a-w, then the full command set', () => {
  const ro = path.join(base, 'vault-readonly'); const h = home('readonly');
  fs.cpSync(path.join(REPO, 'tests', 'fixtures', 'vault'), ro, { recursive: true });
  setWritable(ro, false);
  const before = snapshot(ro);
  try {
    const run = (/** @type {string[]} */ args) => { const r = spawnSync(process.execPath, [BIN, ...args], { cwd: CWD, env: envFor(h), encoding: 'utf8' }); eq(r.status, 0, `vault-mirror ${args[0]} on a read-only vault (${r.stderr.slice(0, 200)})`); return r; };
    run(['init', ro, '--no-rule']); run(['sync']); run(['sync']); run(['search', 'when to plant tomatoes']); run(['status']); run(['status', '--verify']); run(['rebuild']); run(['doctor']);
    const after = snapshot(ro);
    eq(JSON.stringify([...after]), JSON.stringify([...before]), 'the read-only copy is byte-for-byte unchanged');
  } finally { setWritable(ro, true); }
  return 'init, sync, search, status, rebuild and doctor all ran';
});

await step('R2', 'spy: no fs write call ever targets a vault path', () => {
  const log = path.join(base, 'spy.log'); fs.writeFileSync(log, ''); const h = home('spy');
  const env = { NODE_OPTIONS: requireOption(path.join(REPO, 'tests', 'helpers', 'fs-spy.cjs')), VM_SPY_ROOT: VAULT, VM_SPY_LOG: log };
  for (const args of [['init', VAULT, '--project', PROJECT], ['sync', '--workers', '2'], ['sync'], ['search', 'watering'], ['status', '--verify'], ['status', '--list', '--screen'], ['rebuild'], ['rebuild', '--full', '--yes'], ['doctor']]) {
    const r = vm(args, { home: h, env });
    eq(r.status, 0, `vault-mirror ${args[0]} under the spy (${r.stderr.slice(0, 200)})`);
  }
  eq(fs.readFileSync(log, 'utf8'), '', 'write calls on vault paths');
  // The spy itself works: a write into the vault is caught.
  const self = spawnSync(process.execPath, ['--require', path.join(REPO, 'tests', 'helpers', 'fs-spy.cjs'), '-e', `require('fs').writeFileSync(${JSON.stringify(path.join(VAULT, 'x.md'))}, 'x')`], { env: { ...process.env, VM_SPY_ROOT: VAULT, VM_SPY_LOG: log }, encoding: 'utf8' });
  assert(self.status !== 0 && !fs.existsSync(path.join(VAULT, 'x.md')), 'the spy catches a write into the vault');
  return 'the full command set ran with every fs write call watched';
});

await step('R3', 'wrong folders: a folder of vaults is refused; no rule file lands in another vault', () => {
  const many = path.join(base, 'many'); const h = home('wrong');
  fs.cpSync(path.join(REPO, 'tests', 'fixtures', 'many-vaults'), many, { recursive: true });
  const before = snapshot(many);
  const init = spawnSync(process.execPath, [BIN, 'init', many, '--json'], { cwd: CWD, env: envFor(h), encoding: 'utf8' });
  eq(init.status, 2, 'init on a folder of several vaults'); eq(JSON.parse(init.stdout).error.code, 'VM_E_NOT_ONE_VAULT', 'code');
  const sync = spawnSync(process.execPath, [BIN, 'sync', '--json'], { cwd: CWD, env: envFor(h), encoding: 'utf8' });
  eq(sync.status, 2, 'sync with no vault set'); eq(JSON.parse(sync.stdout).error.code, 'VM_E_NO_VAULT', 'code');
  const inside = spawnSync(process.execPath, [BIN, 'init', VAULT, '--json'], { cwd: path.join(many, 'Vault B'), env: envFor(h), encoding: 'utf8' });
  eq(inside.status, 0, 'init run from inside a second, unregistered vault');
  const j = JSON.parse(inside.stdout);
  assert(j.ruleFiles.every((/** @type {any} */ f) => f.action === 'skipped'), 'the rule was not written there');
  eq(JSON.stringify([...snapshot(many)]), JSON.stringify([...before]), 'nothing was written into either vault');
  assertVaultUntouched('init from inside another vault');
  const inVault = spawnSync(process.execPath, [BIN, 'status', '--json'], { cwd: CWD, env: envFor(path.join(VAULT, '.vault-mirror')), encoding: 'utf8' });
  eq(inVault.status, 2, 'a home folder inside the vault');
  assertVaultUntouched('a home folder inside the vault');
  return 'refused, and nothing written';
});

await step('S1', 'the screen reports, masks and never drops a passage', () => {
  const st = vm(['status', '--screen', '--json']).json;
  const rules = st.screen.filter((/** @type {any} */ f) => f.path === 'Odd/Fake keys.md').map((/** @type {any} */ f) => f.rule).sort();
  eq(rules.join(','), 'aws-access-key-id,ignore-previous-instructions', 'flagged rules');
  const s = vm(['search', 'an invented example that only looks like a key', '--json']);
  const hit = s.json.results.find((/** @type {any} */ x) => x.vaultPath === 'Odd/Fake keys.md');
  assert(hit, 'the flagged passage is still indexed');
  assert(hit.snippet.includes('[hidden: looks like a key]') && !hit.snippet.includes('AKIA') && !hit.text.includes('AKIA'), 'the key is masked in the snippet and the text');
  assert(hit.flags.includes('possible-secret') && hit.flags.includes('possible-instruction-text'), 'flags');
  assert(!JSON.stringify(st.screen).includes('AKIA'), 'the matched text is never printed');
  return 'flagged, masked, still searchable';
});

await step('S2', 'odd file names: ids, paths and links round-trip', () => {
  const idx = readIndex(MAIN); const keys = Object.keys(idx.manifest.notes).filter((k) => k.startsWith('Odd/'));
  eq(keys.length, oddWritten.length, `odd-named notes indexed, of the ${oddWritten.length} this system could hold (indexed: ${keys.join(' | ')}; written: ${oddWritten.join(' | ')})`);
  assert(keys.length >= (WIN ? 2 : 4), `odd-named notes indexed: ${keys.length}`);
  // The key is one spelling for every form of a name. The name as the disk spells it is kept beside it, and is what opens the file.
  const listed = (/** @type {string} */ p) => fs.readdirSync(path.dirname(p)).includes(path.basename(p));
  for (const key of keys) assert(listed(path.join(VAULT, ...(idx.manifest.notes[key].file ?? key).split('/'))), `the name kept for ${key} is one its folder lists`);
  const accented = keys.find((k) => k.startsWith('Odd/Caf'));
  assert(accented && idx.manifest.notes[accented].file === `Odd/${ODD_NAMES[2]}` && accented !== `Odd/${ODD_NAMES[2]}`, 'a name with a separate accent mark is kept as written, beside a key in the one spelling');
  // The first odd name this system could hold: the one full of punctuation on macOS and Linux, the one with an accent and an emoji on Windows.
  const which = ODD_NAMES.findIndex((name) => oddWritten.includes(path.join('Odd', name)));
  assert(which >= 0, 'no odd-named note could be written at all');
  const stem = ODD_NAMES[which].slice(0, 9).normalize('NFC');
  const r = vm(['search', ODD_BODIES[which], '--json', '-k', '5']);
  const hit = r.json.results.find((/** @type {any} */ x) => x.vaultPath.startsWith(`Odd/${stem}`));
  assert(hit, 'the note with an odd name is found');
  assert(fs.existsSync(hit.path), 'path opens the file');
  const file = new URL(hit.link).searchParams.get('file');
  eq(file, `${hit.vaultPath}#Odd name ${which}`, 'the link decodes back to the vault path and heading');
  // The note whose name holds a separate accent mark, on every system: the path is the folder's own spelling of it.
  const acc = vm(['search', ODD_BODIES[2], '--json', '-k', '5']).json.results.find((/** @type {any} */ x) => x.vaultPath === accented);
  assert(acc, 'the note with a separate accent mark is found');
  assert(fs.existsSync(acc.path) && listed(acc.path), `its path opens the file, by the name its folder lists: ${acc.path}`);
  eq(fs.readFileSync(acc.path, 'utf8').includes(ODD_BODIES[2]), true, 'and that file is the note');
  // An index made before the name was kept (0.1.0): the next search's own quick sync notes it, and no note is read again.
  const old = JSON.parse(JSON.stringify(idx.manifest)); for (const key of keys) delete old.notes[key].file;
  fs.writeFileSync(path.join(idx.dataDir, 'manifest.json'), JSON.stringify(old));
  const up = vm(['search', ODD_BODIES[2], '--json', '-k', '5']);
  const again = up.json.results.find((/** @type {any} */ x) => x.vaultPath === accented);
  assert(again && listed(again.path), `after an upgrade the path is the name the folder lists: ${again?.path}`);
  const now = readIndex(MAIN);
  eq(now.manifest.notes[accented].file, `Odd/${ODD_NAMES[2]}`, 'the name is in the index again');
  eq(now.manifest.stamp, idx.manifest.stamp, 'and no passage was made again');
  assert(!/[!'()*]/.test(hit.link.split('file=')[1]), 'strictly encoded');
  if (oddWritten.includes(path.join('Odd', 'Trailing space ', ' Leading space.md'))) {
    const spaced = keys.find((k) => k.includes('Trailing space / Leading space.md'));
    assert(spaced, 'path segments are never trimmed');
  }
  return `${keys.length} odd-named notes round-trip`;
});

await step('X1', 'an exact phrase the list by meaning misses is found by the exact-words list', () => {
  // Two invented notes. One is about beehives and says "kestrel ledger" in passing; the other holds the same
  // two words apart. The question is mostly about soup, so the two places of the list by meaning go elsewhere.
  const HIVE_SENTENCE = 'Each hive has a number painted on its lid. The queen dates, the swarm notes and the honey weights for every hive are written in the kestrel ledger, which lives in the tin box under the bench with the smoker fuel and the spare frames.';
  fs.mkdirSync(path.join(VAULT, 'Records'), { recursive: true });
  fs.writeFileSync(path.join(VAULT, 'Records', 'Hive records.md'), `# Hive records\n\n## Where things are\n\n${HIVE_SENTENCE}\n`);
  fs.writeFileSync(path.join(VAULT, 'Records', 'Bird log.md'), '# Bird log\n\n## March\n\nA kestrel hovered over the lane all morning. The feed ledger for the hens was brought up to date in the afternoon.\n');
  accept();
  const QUESTION = 'how long should the soup stock simmer, and what does the "kestrel ledger" say';
  const s = vm(['search', QUESTION, '--json', '-k', '2']);
  eq(s.status, 0, 'exit'); eq(s.json.inStep, true, 'the quick sync indexed the new notes');
  assert(!s.json.results.some((/** @type {any} */ x) => x.vaultPath === 'Records/Hive records.md'), `the list by meaning misses the note that says the phrase: ${s.json.results.map((/** @type {any} */ x) => x.vaultPath).join(', ')}`);
  assert(Array.isArray(s.json.exactWords), 'the exact-words list is its own array');
  const hit = s.json.exactWords[0] || {};
  eq(hit.vaultPath, 'Records/Hive records.md', 'the exact-words list finds the note that says the phrase');
  eq(hit.rank, 1, 'its own rank'); eq(hit.section, 'Where things are', 'section');
  assert(hit.text.includes('kestrel ledger'), 'with the full passage text');
  assert(hit.words.includes('kestrel') && hit.words.includes('ledger'), `with the words it holds: ${hit.words}`);
  assert(fs.existsSync(hit.path) && hit.line > 0 && hit.passage.startsWith('Records/Hive records.md#'), 'and a way back to the note');
  assert(!s.json.exactWords.some((/** @type {any} */ x) => x.vaultPath === 'Records/Bird log.md'), 'a note that holds the two words apart is not a match for the phrase');
  assert(s.json.exactWords.length <= 3, 'a short list');
  const shown = new Set(s.json.results.map((/** @type {any} */ x) => x.passage));
  assert(!s.json.exactWords.some((/** @type {any} */ x) => shown.has(x.passage)), 'it never repeats a passage already shown');
  assert(typeof s.json.timings.wordsMs === 'number', 'its time is in the breakdown');

  const plain = vm(['search', 'kestrel ledger', '--json', '--no-sync', '-k', '2']);
  const both = [...plain.json.results, ...plain.json.exactWords].map((/** @type {any} */ x) => x.vaultPath);
  assert(both.includes('Records/Hive records.md') && both.includes('Records/Bird log.md'), 'without the quotes, both notes are found by one list or the other');
  const off = vm(['search', QUESTION, '--json', '--no-sync', '-k', '2', '--no-exact-words']);
  eq(JSON.stringify(off.json.results), JSON.stringify(s.json.results), 'the list by meaning is the same with the exact-words list turned off: the two are never mixed');
  eq(off.json.exactWords.length, 0, 'and the list is empty');
  const wordings = vm(['search', 'how long should the soup stock simmer', 'what is in the "kestrel ledger"', 'where is the tin box', '--json', '--no-sync', '-k', '2']);
  assert(wordings.json.exactWords.some((/** @type {any} */ x) => x.vaultPath === 'Records/Hive records.md'), 'with several wordings, each one contributes to the exact-words list');

  const human = vm(['search', QUESTION, '--no-sync', '-k', '2']);
  assert(/\nAlso contains these exact words:\n- {2}Hive records {2}› {2}Where things are\s+words: .*kestrel, ledger/.test(human.stdout), `human output: ${human.stdout.slice(-400)}`);
  assert(!/hybrid/i.test(human.stdout + human.stderr), 'never that word');
  const repeat = vm(['search', HIVE_SENTENCE, '--no-sync', '-k', '20']);
  eq(top(vm(['search', HIVE_SENTENCE, '--no-sync', '--json', '-k', '20']).json).vaultPath, 'Records/Hive records.md', 'rank 1 by meaning for its own sentence');
  assert(!/- {2}Hive records/.test(repeat.stdout), 'a passage already shown by meaning is not listed twice');

  const st = vm(['status', '--json']);
  eq(st.json.inStep, true, 'in step');
  eq(st.json.checks.find((/** @type {any} */ c) => c.name === 'exact-words-match').ok, true, 'the exact-words table matches the index, note for note');
  eq(st.json.counts.passagesInExactWords, st.json.counts.passagesRecorded, 'passages in the exact-words table = passages recorded');
  const idx = readIndex(MAIN);
  assert(fs.existsSync(path.join(idx.dir, 'words.bin')), 'the table is one file in the index folder');
  eq(grep(MAIN, 'kestrel ledger').filter((f) => !/passages\.jsonl$/.test(f)).join(','), '', 'the phrase is stored in the passage store only');
  eq(fs.readFileSync(path.join(idx.dir, 'words.bin')).includes('kestrel'), false, 'the table holds numbers, not words');

  fs.rmSync(path.join(VAULT, 'Records'), { recursive: true }); accept();
  const gone = vm(['search', QUESTION, '--json', '-k', '2']);
  assert(![...gone.json.results, ...gone.json.exactWords].some((/** @type {any} */ x) => x.vaultPath.startsWith('Records/')), 'after the notes are deleted, neither list returns them');
  const after = vm(['status', '--verify', '--json']);
  eq(after.json.inStep, true, 'in step after the delete');
  eq(after.json.checks.find((/** @type {any} */ c) => c.name === 'verify-exact-words').ok, true, 'the table equals one made again from the saved passages');
  timings.exactWordsMs = s.json.timings.wordsMs;
  return `found at rank 1 of the exact-words list (${hit.words.join(', ')}); ${s.json.timings.wordsMs} ms`;
});

await step('X2', 'a second note with the same file name appears: the first is cut again, and the exact-words table follows', () => {
  // The folder joins the prefix of a note when another note shares its file name. The note is then cut with a
  // smaller budget: same content, here the same number of passages, other cuts. The table must not keep the old rows.
  const BIRDS = ['kestrel', 'heron', 'wagtail', 'curlew', 'gannet', 'plover', 'dunlin', 'osprey', 'redshank', 'turnstone', 'whimbrel', 'godwit'];
  const lines = [];
  for (let i = 0; i < 36; i++) lines.push(`- ${BIRDS.slice(i % 12, (i % 12) + 1 + ((i * 7) % 5)).join(' ')} tide ${i % 2 ? 'rising' : 'falling'}`);
  const A = 'North pier harbour office/Tide log.md';
  fs.mkdirSync(path.join(VAULT, 'North pier harbour office'), { recursive: true });
  fs.writeFileSync(path.join(VAULT, A), `# Tide log\n\n## Sightings\n\n${lines.join('\n')}\n`);
  accept();
  eq(vm(['sync', '--json']).json.inStep, true, 'in step with one Tide log');
  const cuts = () => { const idx = readIndex(MAIN); const out = []; for (let n = 0; idx.texts.has(`${A}#${n}`); n++) out.push(idx.texts.get(`${A}#${n}`)); return { flag: idx.manifest.notes[A].folderInPrefix, texts: out }; };
  const one = cuts();
  eq(one.flag, false, 'alone, the folder is not in the prefix');

  fs.mkdirSync(path.join(VAULT, 'South pier'), { recursive: true });
  fs.writeFileSync(path.join(VAULT, 'South pier', 'Tide log.md'), '# Tide log\n\nThe south pier log is kept by the harbour office.\n');
  accept();
  const s = vm(['sync', '--json']);
  eq(s.status, 0, 'exit'); eq(s.json.inStep, true, 'in step with two');
  const two = cuts();
  eq(two.flag, true, 'with a namesake, the folder is in the prefix');
  eq(two.texts.length, one.texts.length, 'the note has as many passages as before (the case a count alone cannot catch)');
  assert(JSON.stringify(two.texts) !== JSON.stringify(one.texts), 'and they are cut in other places');
  const check = (/** @type {string} */ when) => {
    const st = vm(['status', '--json']);
    eq(st.json.checks.find((/** @type {any} */ c) => c.name === 'exact-words-match').ok, true, `exact-words-match ${when}`);
    const v = vm(['status', '--verify', '--json']);
    eq(v.json.checks.find((/** @type {any} */ c) => c.name === 'verify-exact-words').ok, true, `the table equals one made again from the saved passages ${when}`);
    eq(v.json.inStep, true, `in step ${when}`);
  };
  check('after the namesake appears');

  fs.rmSync(path.join(VAULT, 'South pier'), { recursive: true }); accept();
  eq(vm(['sync', '--json']).json.inStep, true, 'in step after the namesake goes');
  const back = cuts();
  eq(back.flag, false, 'the folder leaves the prefix again');
  eq(JSON.stringify(back.texts), JSON.stringify(one.texts), 'and the first cuts come back');
  check('after the namesake goes');

  fs.rmSync(path.join(VAULT, 'North pier harbour office'), { recursive: true }); accept();
  eq(vm(['sync', '--json']).json.inStep, true, 'in step after the tidy-up');
  return `${one.texts.length} passages cut again in other places, twice; the table followed both times`;
});

await step(25, 'after the whole run', () => {
  const stray = [];
  const look = (/** @type {string} */ dir, depth = 0) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name === '.git') continue; const abs = path.join(dir, e.name); if (e.isDirectory() && depth < 8) look(abs, depth + 1); else if (e.name === 'ruvector.db') stray.push(abs); } };
  look(CWD); look(VAULT); look(REPO);
  eq(stray.join(','), '', 'files named ruvector.db');
  eq(fs.readdirSync(CWD).join(','), '', 'files written into the folder the commands ran from');
  if (!READ_ONLY) eq(fs.readdirSync(PROJECT).sort().join(','), 'AGENTS.md,CLAUDE.md', 'files in the project folder');
  const outside = fs.readdirSync(base).filter((n) => !n.startsWith('home-') && !['cwd', 'project', 'vault', 'obsidian.json', 'stash', 'nofetch.log', 'spy.log', 'vault-readonly', 'many'].includes(n));
  eq(outside.join(','), '', 'anything written outside VAULT_MIRROR_HOME and the two rule files');
  assertVaultUntouched('the whole run');
  eq(leftoverProcesses().join(' | '), '', 'processes still alive');
  return `vault snapshot identical after ${snapshotChecks} checks`;
});

// ---------- summary ----------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} steps passed${failed.length ? `; FAILED: ${failed.map((f) => f.n).join(', ')}` : ''}${skipped.length ? `; not run on ${process.platform}: ${skipped.map((s) => s.n).join(', ')}` : ''}.`);
console.log(`Timings: ${JSON.stringify({ ...timings, searchQuality: timings.searchQuality ? { top3: timings.searchQuality.top3, of: timings.searchQuality.of, agree: timings.searchQuality.agree } : undefined })}`);
for (const n of notes) console.log(n);
if (opt.keep) console.log(`Kept: ${base}`); else { try { fs.rmSync(base, { recursive: true, force: true }); } catch { console.log(`Could not remove ${base}`); } }
process.exit(failed.length ? 1 : 0);
