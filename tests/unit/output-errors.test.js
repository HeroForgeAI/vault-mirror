import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ERRORS, VmError, toVmError } from '../../src/errors.js';
import { num, duration, eta, plural } from '../../src/cli/output.js';
import { skippedSentence } from '../../src/sync/run.js';
import { tmpDir } from '../helpers/tmp.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createUi } from '../../src/cli/output.js';
import { runSync } from '../../src/sync/run.js';
import { configureWriter } from '../../src/store/safe-write.js';
import os from 'node:os';
import { debug, setLogDir, withoutHome } from '../../src/log.js';

const BIN = fileURLToPath(new URL('../../bin/vault-mirror.js', import.meta.url));
const run = (/** @type {string[]} */ args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, VAULT_MIRROR_HOME: tmpDir('out'), ...env } });

test('code, exit and wording table', () => {
  /** @type {[string, number, Record<string, any>, RegExp, RegExp][]} */
  const table = [
    ['VM_E_NO_VAULT', 2, {}, /^No vault is set up yet\.$/, /vault-mirror init "<path to your vault>"/],
    ['VM_E_NOT_ONE_VAULT', 2, { path: '/x' }, /^\/x is not one vault \(it is your home folder, a folder of several vaults, or a folder inside a vault\)\.$/, /vault-mirror init/],
    ['VM_E_NOT_SYNCED', 2, {}, /^Nothing is indexed yet\.$/, /^Run `vault-mirror sync`\.$/],
    ['VM_E_INDEX_IN_VAULT', 2, {}, /must stay outside so your notes are never touched/, /VAULT_MIRROR_HOME/],
    ['VM_E_MANIFEST_NEWER', 2, {}, /made by a newer vault-mirror/, /rebuild --full/],
    ['VM_E_VAULT_MISSING', 4, { path: '/x' }, /was not found at \/x\. Nothing was changed\.$/, /run it again/],
    ['VM_E_VAULT_EMPTY', 4, { path: '/x', indexed: '1,230' }, /but the index has 1,230\. Nothing was changed\.$/, /finish downloading/],
    ['VM_E_VAULT_DOWNLOADING', 4, {}, /Nothing was removed\.$/, /vault-mirror sync/],
    ['VM_E_MASS_DELETE', 4, { count: '640' }, /^640 notes would leave the index since the last sync\. Nothing was changed, in case that is a mistake\.$/, /--allow-mass-delete/],
    ['VM_E_NODE_OLD', 5, { version: '18.1.0' }, /Node 20 or newer\. You have 18\.1\.0\.$/, /vault-mirror doctor/],
    ['VM_E_MODEL_OFFLINE', 5, {}, /download did not get through/, /vault-mirror doctor/],
    ['VM_E_MODEL_BROKEN', 5, { path: '/m' }, /did not finish downloading/, /^Delete the folder \/m, then run `vault-mirror doctor`\.$/],
    ['VM_E_EMBED_FAILING', 5, {}, /What was done is saved\.$/, /vault-mirror doctor/],
    ['VM_E_DISK_FULL', 5, {}, /Your notes were not touched\.$/, /Free about 500 MB/],
    ['VM_E_BUSY', 6, { percent: 41 }, /^Another sync is still running \(41% done\)\. Nothing is wrong\.$/, /is my vault in sync/],
    ['VM_E_LOCK_LOST', 6, {}, /Nothing is wrong\.$/, /is my vault in sync/],
    ['VM_E_INDEX_BUSY', 6, {}, /using the index right now/, /Try again in a moment/],
    ['VM_E_STOPPED', 130, { done: '812', total: '1,240' }, /^Stopped at 812 of 1,240 notes\.$/, /^Run it again to continue\.$/],
    ['VM_E_INTERNAL', 1, {}, /Your notes were not touched\.$/, /^Run `vault-mirror rebuild`\. It is always safe\./],
  ];
  for (const [code, exit, params, message, next] of table) {
    const e = new VmError(code, params);
    assert.equal(e.exitCode, exit, code);
    assert.match(e.message, message, code);
    assert.match(e.next, next, code);
    assert.ok(!/\n/.test(e.message), 'one plain sentence');
  }
  assert.deepEqual(Object.keys(ERRORS).filter((c) => c !== 'VM_E_USAGE').sort(), table.map((t) => t[0]).sort(), 'every code is in the table');
  // No message offers both rebuild and doctor.
  for (const code of Object.keys(ERRORS)) { const e = new VmError(code, { path: '/x' }); assert.ok(!(/rebuild/.test(e.next) && /doctor/.test(e.next)), code); }
  assert.equal(toVmError(Object.assign(new Error('x'), { code: 'ENOSPC' })).code, 'VM_E_DISK_FULL');
  assert.equal(toVmError(new TypeError('oops')).code, 'VM_E_INTERNAL');
});

test('plain numbers and durations', () => {
  assert.equal(num(18400), '18,400');
  assert.equal(duration(1.42), '1.4 s');
  assert.equal(duration(0.052), '0.05 s');
  assert.equal(duration(0.001), '0.01 s');
  assert.equal(duration(0.097), '0.1 s');
  assert.equal(duration(490), '8 min 10 s');
  assert.equal(duration(62), '1 min 2 s');
  assert.equal(eta(300), 'about 5 min left');
  assert.equal(plural(1, 'note'), '1 note');
  assert.equal(plural(1240, 'note'), '1,240 notes');
  assert.equal(skippedSentence([{ path: 'a', reason: 'changing' }]), 'In step: not yet. 1 note was being saved while it was read. Run vault-mirror sync again.');
});

test('--json prints exactly one object and nothing else, also for an error', () => {
  const r = run(['status', '--json']);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, '');
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const body = JSON.parse(lines[0]);
  assert.deepEqual([body.schema, body.ok, body.command, body.version, body.error.code, body.error.exitCode], [1, false, 'status', '0.1.0', 'VM_E_NO_VAULT', 2]);
  assert.ok(body.error.message && body.error.next && Array.isArray(body.warnings));
});

test('human errors: one sentence, one next action, no stack trace', () => {
  const r = run(['sync']);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'No vault is set up yet.\nNext: Run `vault-mirror init "<path to your vault>"`.\n');
  const bad = run(['sync', '--no-such-flag']);
  assert.equal(bad.status, 2);
  assert.ok(!/at .*\.js:\d+/.test(bad.stderr), 'no stack trace on screen');
  assert.equal(bad.stderr, 'sync has no option --no-such-flag.\nNext: Run `vault-mirror --help`.\n', 'our own sentence, not the argument parser\'s');
  assert.equal(JSON.parse(run(['sync', '--bogus', '--json']).stdout).error.message, 'sync has no option --bogus.');
  assert.match(run(['sync', '--workers']).stderr, /^Option '--workers <value>' argument missing\.\nNext: /, 'other parser sentences are already plain');
  assert.equal(run(['frobnicate']).status, 2);
  assert.equal(run(['sync', '/some/path']).status, 2, 'sync takes no path');
});

test('--help lists exactly the six commands and makes no saving claim', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  const commands = r.stdout.split('Commands:')[1].split('Options for every command:')[0].trim().split('\n').map((l) => l.trim().split(/\s+/)[0]);
  assert.deepEqual(commands, ['init', 'sync', 'search', 'status', 'rebuild', 'doctor']);
  assert.ok(!/times less|x fewer|instant|hybrid/i.test(r.stdout));
  assert.equal(run(['--version']).stdout, '0.1.0\n');
});

test('full rebuild rejects invalid workers like sync, before starting an index', () => {
  const home = tmpDir('workers'); const vault = path.join(tmpDir('workers'), 'notes');
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  const note = '# A\n\nOne invented sentence about a garden.\n';
  fs.writeFileSync(path.join(vault, 'A.md'), note);
  const env = { VAULT_MIRROR_HOME: home };
  const init = run(['init', vault, '--no-rule', '--json'], env);
  assert.equal(init.status, 0, init.stderr);
  const indexDir = JSON.parse(init.stdout).indexDir;
  // If argument validation is missing, fail at model selection rather than downloading a model.
  const configFile = path.join(home, 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.embedding.model = 'unsupported-workers-test-model';
  fs.writeFileSync(configFile, JSON.stringify(config));
  const message = '--workers takes a number, for example --workers 2.';
  for (const workers of ['abc', '-1', 'Infinity']) {
    for (const args of [['sync'], ['rebuild', '--full', '--yes'], ['rebuild', '--full']]) {
      const human = run([...args, `--workers=${workers}`], env);
      assert.equal(human.status, 2);
      assert.equal(human.stdout, '');
      assert.equal(human.stderr, `${message}\nNext: Run \`vault-mirror --help\`.\n`);
      const json = run([...args, `--workers=${workers}`, '--json'], env);
      assert.equal(json.status, 2);
      assert.equal(json.stderr, '');
      const body = JSON.parse(json.stdout);
      assert.equal(body.error.code, 'VM_E_USAGE');
      assert.equal(body.error.message, message);
      assert.equal(body.error.exitCode, 2);
      assert.equal(fs.existsSync(indexDir), false, 'runSync must not start');
      assert.equal(fs.readFileSync(path.join(vault, 'A.md'), 'utf8'), note);
    }
  }
});

test('a --json error names the vault once one is set', () => {
  const home = tmpDir('out'); const vault = path.join(tmpDir('out'), 'notes');
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'A.md'), '# A\n\nOne plain sentence about a garden.\n');
  const env = { VAULT_MIRROR_HOME: home };
  const failedInit = JSON.parse(run(['init', path.join(vault, 'missing'), '--no-rule', '--json'], env).stdout);
  assert.deepEqual([failedInit.error.code, failedInit.vault], ['VM_E_VAULT_MISSING', null], 'no vault is set yet');
  assert.equal(run(['init', vault, '--no-rule', '--json'], env).status, 0);
  const r = run(['search', 'anything', '--json'], env);
  const body = JSON.parse(r.stdout);
  assert.equal(body.error.code, 'VM_E_NOT_SYNCED');
  assert.deepEqual(body.vault, { name: 'notes', path: vault });
  assert.deepEqual(JSON.parse(run(['sync', '--bogus', '--json'], env).stdout).vault, { name: 'notes', path: vault }, 'also for a usage error');
});

test('the busy error says how far the other sync is, also in --json', async () => {
  const home = tmpDir('busy'); const vault = path.join(home, 'vault'); const indexDir = path.join(home, 'indexes', 'v-00000000');
  fs.mkdirSync(vault); fs.mkdirSync(indexDir, { recursive: true });
  configureWriter({ home });
  // Another sync, alive (this process stands in for it), 41% through.
  fs.writeFileSync(path.join(indexDir, 'sync.lock'), JSON.stringify({ pid: process.pid, token: 'someone-else', command: 'sync', startedAt: Date.now() }));
  fs.writeFileSync(path.join(indexDir, 'progress.json'), JSON.stringify({ pid: process.pid, passagesDone: 41, passagesTotal: 100, etaSeconds: 30 }));
  const ctx = /** @type {any} */ ({ home, cfg: { vault: {}, embedding: { model: 'all-MiniLM-L6-v2' } }, vault: { real: vault, name: 'vault', opened: false }, indexDir });
  const busy = (/** @type {any} */ e) => e instanceof VmError && e.code === 'VM_E_BUSY' && e.message === 'Another sync is still running (41% done). Nothing is wrong.';
  await assert.rejects(runSync(ctx, { waitSeconds: 0 }, createUi({ json: true })), busy);
  fs.rmSync(path.join(indexDir, 'progress.json'));
  await assert.rejects(runSync(ctx, { waitSeconds: 0 }, createUi({ json: true })), (/** @type {any} */ e) => e.message === 'Another sync is still running. Nothing is wrong.', 'no percent when none is known');
});

test('the debug log, which a person may share, never holds the home folder and so never the account name', () => {
  const home = tmpDir('log'); const logs = path.join(home, 'logs');
  configureWriter({ home });
  setLogDir(logs);
  try {
    // What an internal error writes: a stack trace whose frames name files under the home folder.
    const stack = `Error: Failed to initialize ONNX embedder | at ${path.join(os.homedir(), 'tools', 'node_modules', 'ruvector', 'dist', 'core', 'onnx-embedder.js')}:363:25 | at ${path.join(os.homedir(), '.npm', 'lib', 'x.js')}:1:1`;
    debug(`internal error in sync: ${stack}`);
  } finally { setLogDir(null); }
  const text = fs.readFileSync(path.join(logs, 'debug.log'), 'utf8');
  assert.ok(!text.includes(os.homedir()), text);
  assert.ok(!text.includes(os.userInfo().username) || !os.homedir().includes(os.userInfo().username), text);
  assert.match(text, / at ~[\\/]tools[\\/]node_modules[\\/]ruvector[\\/]dist[\\/]core[\\/]onnx-embedder\.js:363:25 /, 'the rest of the trace is kept');
  assert.equal(withoutHome('no path here'), 'no path here');
});
