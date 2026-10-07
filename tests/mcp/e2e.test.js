// End to end: the real `vault-mirror mcp` server over stdio, driven by the official SDK client, on a copy
// of the invented fixture vault. It needs the reading model (downloaded once, about 90 MB), so it is not
// one of the unit tests. Run it with: npm run test:mcp
//
// The read-only proof here is the same three-part proof the commands have: a checksum listing of every
// vault file before and after every tool has run, a spy that throws on any write call under the vault
// (loaded into the server and into every process it starts), and the list of tools itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { tmpDir } from '../helpers/tmp.mjs';
import { makeFiller } from '../helpers/make-notes.mjs';
import { BIN, FIXTURE_VAULT, FS_SPY, copyVault, vaultListing, alive, waitFor, startRaw, strayLines } from '../helpers/mcp.mjs';

const home = tmpDir('mcp-e2e-home');
const vault = copyVault(FIXTURE_VAULT, path.join(tmpDir('mcp-e2e-vault'), 'garden notes'));
const spyLog = path.join(tmpDir('mcp-e2e-spy'), 'writes.log');
/** What the server is started with. The spy rides along in NODE_OPTIONS, so the reader and every sync it starts carry it too. */
const env = /** @type {Record<string, string>} */ ({
  ...process.env, VAULT_MIRROR_HOME: home, VAULT_MIRROR_OBSIDIAN_JSON: path.join(home, 'no-obsidian.json'),
  VM_SPY_ROOT: vault, VM_SPY_LOG: spyLog, NODE_OPTIONS: `--require "${FS_SPY.replace(/\\/g, '/')}"`,
});
const cli = (/** @type {string[]} */ args) => spawnSync(process.execPath, [BIN, ...args, '--json'], { encoding: 'utf8', env, cwd: home });
const json = (/** @type {{ stdout: string }} */ r) => JSON.parse(r.stdout.trim().split('\n').pop() || '{}');

/** @type {Client} */
let client;
/** @type {StdioClientTransport} */
let transport;
let serverErr = '';
/** @type {number} */
let serverPid;

/** @param {string} name @param {Record<string, any>} [args] */
async function call(name, args = {}) {
  const started = performance.now();
  const r = /** @type {any} */ (await client.callTool({ name, arguments: args }));
  if (!r.isError) assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent, `${name}: the text is the same object`);
  return { ...r, out: r.structuredContent, text: r.content[0].text, ms: Math.round(performance.now() - started) };
}

/** Call sync_index until the sync it started has finished. @param {number} wait */
async function syncToEnd(wait) {
  const first = await call('sync_index', { wait_seconds: wait });
  assert.ok(!first.isError, first.text);
  let last = first;
  for (let i = 0; i < 60 && !last.out.finished; i++) { last = await call('sync_index', { wait_seconds: 20 }); assert.ok(!last.isError, last.text); }
  assert.equal(last.out.finished, true, 'the sync finished');
  return { first, last };
}

test('set up: one vault, nothing synced, and the server started from another folder', async () => {
  const init = cli(['init', vault, '--no-rule']);
  assert.equal(init.status, 0, init.stderr);
  // Started in a folder that has nothing to do with the vault or the index: it finds both from the settings file.
  transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], env, cwd: tmpDir('mcp-e2e-elsewhere'), stderr: 'pipe' });
  transport.stderr?.on('data', (d) => { serverErr += d; });
  client = new Client({ name: 'e2e', version: '1' });
  await client.connect(transport);
  serverPid = /** @type {number} */ (transport.pid);
  assert.ok(alive(serverPid));
  assert.equal(client.getServerVersion()?.name, 'vault-mirror');
});

test('every tool, on the fixture vault, with the vault checksummed before and after', async (t) => {
  const before = vaultListing(vault);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name), ['search_vault', 'vault_status', 'sync_index']);
  const called = new Set();

  // Before any sync: plain answers, each with one next step.
  const early = await call('search_vault', { query: 'why is the fruit going black underneath' }); called.add('search_vault');
  assert.deepEqual([early.isError, early.text], [true, 'Nothing is indexed yet.\nNext: Call sync_index, then search again.']);
  const notYet = await call('vault_status'); called.add('vault_status');
  assert.deepEqual([notYet.out.vault, notYet.out.inStep, notYet.out.notesInIndex, notYet.out.next], ['garden notes', false, 0, 'Call sync_index.']);

  // The first sync. On a slow machine it outlasts one call; the tool then says how far it is and the next call picks it up.
  const { first, last } = await syncToEnd(45); called.add('sync_index');
  assert.equal(first.out.started, true);
  assert.equal(last.out.inStep, true);
  const done = first.out.finished ? first.out : null;
  if (done) { assert.ok(done.changes.added > 10 && done.changes.added <= notYet.out.notesThatBelong); assert.ok(done.passages > 0); } // before a first sync, a note left out by its own properties still counts as waiting

  const status = await call('vault_status');
  const s = status.out;
  assert.deepEqual([s.inStep, s.notesInIndex, s.waiting, s.couldNotRead, s.syncRunning, s.next], [true, s.notesThatBelong, { new: 0, changed: 0, removed: 0 }, 0, null, undefined]);
  assert.equal(s.notesOnDisk, s.notesThatBelong + s.leftOutOnPurpose);
  assert.ok(s.passages > s.notesInIndex && s.lastSync && s.lastSync.at);
  assert.deepEqual(json(cli(['status'])).counts.notesIndexed, s.notesInIndex, 'the same count the command gives');

  // Search: the structured result of the README's own example.
  const cold = await call('search_vault', { query: 'why is the fruit going black underneath', limit: 1 });
  assert.ok(!cold.isError, cold.text);
  assert.deepEqual(Object.keys(cold.out.results[0]), ['note', 'heading', 'path', 'line', 'score', 'text'], 'no link until Obsidian has opened the folder, and no field said twice');
  assert.deepEqual(cold.out.results[0], { note: 'Tomatoes', heading: 'Problems', path: path.join(vault, 'Garden', 'Tomatoes.md'), line: 13, score: cold.out.results[0].score, text: 'Blossom end rot shows up as a dark patch on the base of the fruit. It comes from uneven watering, not disease.' });
  assert.ok(cold.out.results[0].score > 0.3 && cold.out.results[0].score < 0.6);
  assert.equal(fs.readFileSync(cold.out.results[0].path, 'utf8').split(/\r?\n/)[12].startsWith('Blossom end rot'), true, 'the path and line point at the passage');
  assert.deepEqual([cold.out.vault, cold.out.results.length, cold.out.modelWasLoaded], ['garden notes', 1, false]);
  assert.deepEqual(cold.out.index, { notes: s.notesInIndex, passages: s.passages, notesWaiting: 0, syncRunning: false });
  assert.ok(cold.out.words.inPassages >= 22 && cold.out.words.inPassages < cold.out.words.inTheirNotes, 'words read, beside words in the source notes');
  assert.ok(cold.out.notices.some((/** @type {string} */ n) => /Open this folder as a vault in Obsidian once/.test(n)));
  // The same question through the command gives the same passage and the same score.
  const viaCli = json(cli(['search', 'why is the fruit going black underneath', '-k', '1', '--no-sync']));
  assert.deepEqual([viaCli.results[0].path, viaCli.results[0].line, viaCli.results[0].text.replace(/\s+/g, ' ').trim()], [cold.out.results[0].path, 13, cold.out.results[0].text]);
  assert.ok(Math.abs(viaCli.results[0].score - cold.out.results[0].score) < 0.002);

  // Repeat searches reuse the loaded model.
  /** @type {number[]} */
  const warm = [];
  for (let i = 0; i < 5; i++) { const r = await call('search_vault', { query: 'why is the fruit going black underneath', limit: 1 }); assert.equal(r.out.modelWasLoaded, true); assert.deepEqual(r.out.results, cold.out.results); warm.push(r.out.tookMs); }
  const viaCliMs = json(cli(['search', 'why is the fruit going black underneath', '-k', '1', '--no-sync'])).tookMs;
  t.diagnostic(`search timings on this machine: command ${viaCliMs} ms inside the process (plus its start-up); MCP first search ${cold.out.tookMs} ms; MCP repeat searches ${warm.join(', ')} ms`);
  assert.ok(Math.min(...warm) < cold.out.tookMs, `a repeat search (${Math.min(...warm)} ms) is faster than the first (${cold.out.tookMs} ms)`);

  // Several wordings, and the second list.
  const both = await call('search_vault', { query: 'when should I feed the tomatoes', other_wordings: ['tomato fertiliser schedule'], limit: 2 });
  assert.equal(both.out.results.length, 2);
  assert.ok(both.out.results.some((/** @type {any} */ x) => x.note === 'Tomatoes' && x.heading === 'Feeding'));
  assert.ok(both.out.results[0].score >= both.out.results[1].score);
  const words = both.out.exactWords.find((/** @type {any} */ x) => x.note === 'Sourdough');
  assert.ok(words, 'a passage that holds the very word asked for is in the second list');
  assert.deepEqual([words.heading, words.words, words.score], ['Feeding the starter', ['feed'], undefined]);

  // A question longer than the reader's padding is read whole, by a reader started at the full length.
  const long = await call('search_vault', { query: 'how do I keep a sourdough starter alive when I am away for two weeks and nobody can feed it and the kitchen is cold and the jar is small and the flour is rye and what about the water temperature and the discard and the feeding ratio and anything else I wrote about bread baking in the winter months at home', limit: 1 });
  assert.deepEqual([long.out.results[0].note, long.out.modelWasLoaded], ['Sourdough', false]);
  assert.equal((await call('search_vault', { query: 'feeding the starter', limit: 1 })).out.results[0].note, 'Sourdough');

  // Calls a client must not be able to make.
  for (const args of [{ query: 'x', path: path.join(vault, 'Home.md') }, { query: 'x', content: 'new text' }, {}]) assert.equal((await call('search_vault', args)).isError, true);
  assert.equal((await call('sync_index', { vault: vault + '-other' })).isError, true);
  await assert.rejects(async () => { const r = /** @type {any} */ (await client.callTool({ name: 'write_note', arguments: { path: path.join(vault, 'New.md'), text: 'x' } })); if (r.isError) throw new Error('no such tool'); });

  // A second sync with nothing to do, through the tool.
  const again = await call('sync_index', { wait_seconds: 45 });
  assert.deepEqual([again.out.started, again.out.finished, again.out.inStep, again.out.changes.added, again.out.changes.updated], [true, true, true, 0, 0]);

  assert.deepEqual([...called].sort(), tools.map((x) => x.name).sort(), 'every tool the server lists was run');
  assert.equal(vaultListing(vault), before, 'no file in the vault was created, changed, touched, moved or removed');
});

test('a long-running server never keeps the commands waiting, and sees what they change', async () => {
  // The person edits the vault (the tool never does), then syncs from a terminal while the server is open.
  fs.appendFileSync(path.join(vault, 'Garden', 'Tomatoes.md'), '\n## Pruning\n\nPinch out the side shoots every week so the plant puts its strength into the fruit.\n');
  const before = vaultListing(vault);
  const stale = await call('search_vault', { query: 'when should I pinch out shoots', limit: 1 });
  assert.deepEqual([stale.out.index.notesWaiting, stale.out.notices[0]], [1, '1 note is waiting to sync. This search covers what is indexed so far. Next: call sync_index.']);
  assert.notEqual(stale.out.results[0]?.heading, 'Pruning');

  const started = Date.now();
  const sync = cli(['sync']);
  assert.equal(sync.status, 0, sync.stdout + sync.stderr);
  assert.deepEqual([json(sync).inStep, json(sync).counts.updated], [true, 1]);
  const search = cli(['search', 'when should I pinch out shoots', '-k', '1']);
  assert.equal(search.status, 0, search.stdout + search.stderr);
  assert.ok(Date.now() - started < 60000, 'neither command waited on the server for the index');
  assert.ok(alive(serverPid), 'and the server is still there');

  const fresh = await call('search_vault', { query: 'when should I pinch out shoots', limit: 1 });
  assert.deepEqual([fresh.out.results[0].note, fresh.out.results[0].heading, fresh.out.index.notesWaiting, fresh.out.modelWasLoaded], ['Tomatoes', 'Pruning', 0, true]);
  assert.equal(fresh.out.index.passages, stale.out.index.passages + 1, 'the server loaded the index again by itself');
  assert.equal(vaultListing(vault), before);
});

test('a search during a sync gives a clear answer, stale but usable, and never hangs', async () => {
  makeFiller(vault, 60); // the person adds notes; a sync of these takes a little while
  const before = vaultListing(vault);
  const kicked = await call('sync_index', { wait_seconds: 0 });
  assert.deepEqual([kicked.out.started, kicked.out.finished, kicked.out.inStep], [true, false, null]);
  assert.match(kicked.out.next, /still running in the background.*Call vault_status/);
  assert.ok(kicked.ms < 5000, 'it answered at once and left the sync running');

  // While it runs: searches answer from what is saved, a second sync is not started beside the first, status says how far it is.
  let sawRunning = 0;
  for (let i = 0; i < 6; i++) {
    const r = await call('search_vault', { query: 'why is the fruit going black underneath', limit: 1 });
    assert.ok(!r.isError, r.text);
    assert.equal(r.out.results[0].note, 'Tomatoes');
    assert.ok(r.ms < 20000, `a search took ${r.ms} ms during a sync`);
    if (r.out.index.syncRunning) { sawRunning++; assert.match(r.out.notices[0], /^A sync is running( \(\d+% done\))?\. This search covers what is saved so far\.$/); assert.equal(r.out.index.notesWaiting, null); }
  }
  const second = await call('sync_index', { wait_seconds: 0 });
  if (!second.out.finished) assert.equal(second.out.started, false, 'the running sync was left to carry on');
  const mid = await call('vault_status');
  assert.ok(!mid.isError, mid.text);
  if (mid.out.syncRunning) { assert.equal(mid.out.inStep, false); assert.match(mid.out.next, /^A sync is running\./); }

  let last = second;
  for (let i = 0; i < 60 && !last.out.finished; i++) last = await call('sync_index', { wait_seconds: 20 });
  assert.equal(last.out.finished, true);
  const end = await call('vault_status');
  assert.deepEqual([end.out.inStep, end.out.syncRunning, end.out.waiting], [true, null, { new: 0, changed: 0, removed: 0 }]);
  const found = await call('search_vault', { query: 'the bee hives were repaired after heavy rain', limit: 3 });
  assert.ok(found.out.results.some((/** @type {any} */ x) => /^Filler \d+$/.test(x.note)), 'the new notes are found without restarting the server');
  assert.equal(found.out.index.notes, end.out.notesInIndex);
  t_diag.push(`searches that met the running sync: ${sawRunning} of 6`);
  assert.equal(vaultListing(vault), before);
});
/** @type {string[]} */
const t_diag = [];

test('nothing but the protocol on stdout, nothing written under the vault, and nothing left running', async (t) => {
  for (const line of t_diag) t.diagnostic(line);
  // A second server, spoken to by hand so every byte it prints can be read, with the model loading and a search running.
  const raw = startRaw([], env);
  try {
    await raw.open();
    const r = await raw.call('search_vault', { query: 'why is the fruit going black underneath', limit: 1 });
    assert.equal(r.structuredContent.results[0].note, 'Tomatoes');
    const st = await raw.call('vault_status');
    assert.equal(st.structuredContent.inStep, true);
    const sy = await raw.call('sync_index', { wait_seconds: 45 });
    assert.equal(sy.structuredContent.finished, true);
    assert.equal(await raw.end(), 0);
    assert.deepEqual(strayLines(raw.stdout()), [], 'every stdout line is one JSON-RPC message');
    assert.equal(raw.stdout().includes('\r'), false, 'messages end with a line feed alone on every system');
    assert.match(raw.stderr(), /MCP server ready on stdio/);
    assert.doesNotMatch(raw.stderr() + raw.stdout(), /ONNX|Loading|Disk cache/, 'the library\'s chatter reached neither stream');
  } finally { raw.child.kill(); }

  await client.close();
  assert.ok(await waitFor(() => !alive(serverPid), 5000), 'the server left when the client closed');
  assert.match(serverErr, /MCP server ready on stdio/);

  // Every reader the servers started is named in the debug log by process id. None is still alive.
  const indexDir = path.join(home, 'indexes', fs.readdirSync(path.join(home, 'indexes'))[0]);
  const log = fs.readFileSync(path.join(indexDir, 'logs', 'debug.log'), 'utf8');
  const readers = [...log.matchAll(/mcp reader started pid=(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(readers.length >= 2, 'the readers were started as separate processes');
  assert.ok(await waitFor(() => readers.every((pid) => !alive(pid)), 5000), 'no reader is left running');
  assert.doesNotMatch(log, /fruit|Tomatoes|sourdough/i, 'the debug log holds no question and no note name');
  assert.ok(!fs.existsSync(path.join(indexDir, 'index.lock')) || !alive(JSON.parse(fs.readFileSync(path.join(indexDir, 'index.lock'), 'utf8')).pid), 'no live process holds the index');

  assert.equal(fs.existsSync(spyLog) ? fs.readFileSync(spyLog, 'utf8') : '', '', 'the write spy saw no write call under the vault, in any process');
  assert.ok(!fs.readdirSync(vault).some((n) => /vault-mirror|\.lock$|\.tmp/.test(n)));
});
