#!/usr/bin/env node
// A scale check without hours of embedding: builds an invented vault of small notes and an
// index of the wanted size whose vectors are synthetic (clustered, unit length), then times
// the real commands against it. The engine, the sidecar, the walk and the question embedding
// are all real; only the stored vectors are made up, so search results mean nothing here.
//
//   node tests/bench/scale.mjs --dir <empty scratch folder> [--notes 2000] [--passages 40000] [--runs 5]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { configureWriter } from '../../src/store/safe-write.js';
import { loadConfig, indexDirFor } from '../../src/config/config.js';
import { newManifest, saveManifest, switchCurrent } from '../../src/store/manifest.js';
import { createDataDir, openSidecar } from '../../src/store/sidecar.js';
import { createEmbedder } from '../../src/embed/embedder.js';
import { chunkerBlock, engineBlock } from '../../src/sync/run.js';
import { sentence } from '../helpers/make-notes.mjs';

const { values: o } = parseArgs({ options: { dir: { type: 'string' }, notes: { type: 'string', default: '2000' }, passages: { type: 'string', default: '40000' }, runs: { type: 'string', default: '5' } } });
if (!o.dir) { console.error('Usage: node tests/bench/scale.mjs --dir <empty scratch folder>'); process.exit(2); }
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'vault-mirror.js');
const dir = path.resolve(o.dir); fs.mkdirSync(dir, { recursive: true });
const vault = path.join(dir, 'vault'); const home = path.join(dir, 'home'); const cwd = path.join(dir, 'cwd');
const N = Number(o.notes); const P = Number(o.passages); const per = Math.ceil(P / N); const RUNS = Number(o.runs);
for (const d of [vault, home, cwd]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(cwd, { recursive: true });
for (let i = 0; i < N; i++) {
  const folder = path.join(vault, `Area ${String(i % 40).padStart(2, '0')}`);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, `Note ${i}.md`), `# Note ${i}\n\n${sentence(i)} ${sentence(i + 7)}\n`);
}
const env = { ...process.env, VAULT_MIRROR_HOME: home, NO_COLOR: '1' };
const vm = (/** @type {string[]} */ args) => { const t = performance.now(); const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 1 << 26 }); return { ms: performance.now() - t, status: r.status, stdout: r.stdout, stderr: r.stderr }; };
if (vm(['init', vault, '--no-rule']).status !== 0) throw new Error('init failed');

// Fabricate the index through the tool's own store code.
const vaultReal = fs.realpathSync(vault);
configureWriter({ home, vault: vaultReal });
const cfg = loadConfig(home);
const indexDir = indexDirFor(home, vaultReal);
const embedder = createEmbedder({ model: cfg.embedding.model });
const dims = embedder.dimensions;
const ctx = /** @type {any} */ ({ home, cfg, vault: { real: vaultReal, name: 'vault' }, indexDir });
const dataDir = path.join(indexDir, 'data-0001');
const manifest = newManifest({ dataName: 'data-0001', vault: { name: 'vault', path: vaultReal, pathHash: path.basename(indexDir).slice(-8) }, chunker: chunkerBlock(ctx, embedder), embedding: { ...embedder.identity(null), spaceId: null }, engine: engineBlock() });
manifest.sidecar.logBytes = createDataDir(dataDir, {});
let seed = 12345; const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
const centres = Array.from({ length: 300 }, () => Float32Array.from({ length: dims }, gauss));
const makeVector = () => { const c = centres[Math.floor(rnd() * 300)]; const v = new Float32Array(dims); let n = 0; for (let d = 0; d < dims; d++) { v[d] = c[d] + 0.6 * gauss(); n += v[d] * v[d]; } n = Math.sqrt(n); for (let d = 0; d < dims; d++) v[d] /= n; return v; };
const side = openSidecar(dataDir, manifest.sidecar, dims);
const t0 = performance.now();
for (let i = 0; i < N; i += 100) {
  const batch = [];
  for (let k = i; k < Math.min(N, i + 100); k++) {
    const key = `Area ${String(k % 40).padStart(2, '0')}/Note ${k}.md`; const abs = path.join(vaultReal, key); const st = fs.statSync(abs);
    batch.push({ key, st, record: { v: /** @type {1} */ (1), op: /** @type {'put'} */ ('put'), path: key, sha256: crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'), size: st.size, mtimeMs: Math.floor(st.mtimeMs), fip: false, title: `Note ${k}`, passages: Array.from({ length: per }, (_, n) => ({ n, trail: [`Part ${n}`], line: 3, text: Array.from({ length: 5 }, (_, s) => sentence(k * 31 + n * 7 + s)).join(' '), flags: [] })) }, vectors: Array.from({ length: per }, makeVector) });
  }
  const where = side.appendPuts(batch);
  batch.forEach((b, j) => { manifest.notes[b.key] = { sha256: b.record.sha256, size: b.st.size, mtimeMs: Math.floor(b.st.mtimeMs), racy: false, passages: per, folderInPrefix: false, log: where[j].log, vec: where[j].vec, flagged: 0 }; });
}
manifest.sidecar.logBytes = side.logBytes; manifest.sidecar.vectors = side.vectors; side.close();
manifest.lastRun = { at: new Date().toISOString(), seconds: 0, complete: true, counts: { skipped: 0 } };
saveManifest(dataDir, manifest); switchCurrent(indexDir, 'data-0001');
const fabricateSeconds = (performance.now() - t0) / 1000;

const median = (/** @type {number[]} */ xs) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)]); };
const many = (/** @type {string[]} */ args) => { const runs = Array.from({ length: RUNS }, () => vm(args)); if (runs.some((r) => r.status !== 0)) throw new Error(`${args.join(' ')} failed: ${runs[0].stderr || runs[0].stdout}`); return { medianMs: median(runs.map((r) => r.ms)), minMs: Math.round(Math.min(...runs.map((r) => r.ms))), last: runs[runs.length - 1] }; };
const firstLoad = vm(['status', '--json']); // builds the engine file from the sidecar
const status = many(['status', '--json']);
const inStep = JSON.parse(status.last.stdout).inStep;
const syncNothing = many(['sync', '--json']);
const searchCold = many(['search', 'when does the ferry rope need checking', '--no-sync', '--json']);
const searchNoBlend = many(['search', 'when does the ferry rope need checking', '--no-sync', '--json', '--no-blend']);
const searchNoExact = many(['search', 'when does the ferry rope need checking', '--no-sync', '--json', '--no-exact-words']);
const searchPhrase = many(['search', 'when does "the ferry rope" need checking', '--no-sync', '--json']);
const searchSync = many(['search', 'when does the ferry rope need checking', '--json']);
const searchThree = many(['search', 'when does the ferry rope need checking', 'ferry rope inspection', 'how often to check the mooring line', '--no-sync', '--json']);
const rebuild = vm(['rebuild', '--json']);
fs.appendFileSync(path.join(vaultReal, 'Area 00', 'Note 0.md'), '\nA new line about the orchard gate was added after the storm.\n');
const oneEdit = vm(['sync', '--json']);
const afterEdit = vm(['status', '--json']);
const verify = vm(['status', '--verify', '--json']);
const du = (/** @type {string} */ d) => { let n = 0; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const a = path.join(d, e.name); n += e.isDirectory() ? du(a) : fs.statSync(a).size; } return n; };
const rss = (/** @type {string[]} */ args) => { const r = spawnSync('/usr/bin/time', ['-l', process.execPath, BIN, ...args], { cwd, env, encoding: 'utf8' }); const m = /(\d+)\s+maximum resident set size/.exec(r.stderr); return m ? Math.round(Number(m[1]) / 1048576) : null; };
const out = {
  machine: `${os.cpus()[0].model}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB`, node: process.version, loadAtEnd: os.loadavg().map((x) => +x.toFixed(1)),
  notes: N, passages: N * per, vectors: 'synthetic (clustered, unit length)', fabricateSeconds: +fabricateSeconds.toFixed(1),
  engineFirstLoadMs: Math.round(firstLoad.ms), inStep,
  statusMs: status.medianMs, syncNothingChangedMs: syncNothing.medianMs,
  searchColdNoSyncMs: searchCold.medianMs, searchColdNoSyncBreakdown: JSON.parse(searchCold.last.stdout).timings,
  searchNoBlendMs: searchNoBlend.medianMs, searchNoBlendBreakdown: JSON.parse(searchNoBlend.last.stdout).timings,
  searchNoExactWordsMs: searchNoExact.medianMs, searchNoExactWordsBreakdown: JSON.parse(searchNoExact.last.stdout).timings,
  searchQuotedPhraseMs: searchPhrase.medianMs, searchQuotedPhraseBreakdown: JSON.parse(searchPhrase.last.stdout).timings, exactWordsListed: JSON.parse(searchCold.last.stdout).exactWords.length,
  searchWithQuickSyncMs: searchSync.medianMs, searchWithQuickSyncBreakdown: JSON.parse(searchSync.last.stdout).timings,
  searchThreeWordingsMs: searchThree.medianMs, searchThreeBreakdown: JSON.parse(searchThree.last.stdout).timings,
  rebuildFromSidecarMs: Math.round(rebuild.ms), oneEditSyncMs: Math.round(oneEdit.ms), oneEditJson: (() => { try { const j = JSON.parse(oneEdit.stdout); return { updated: j.counts.updated, embedded: j.passages.embedded, seconds: j.seconds }; } catch { return oneEdit.stdout.slice(0, 200); } })(),
  inStepAfterEdit: (() => { try { return JSON.parse(afterEdit.stdout).inStep; } catch { return null; } })(),
  statusVerifyMs: Math.round(verify.ms), verifyInStep: (() => { try { return JSON.parse(verify.stdout).inStep; } catch { return null; } })(),
  indexFolderMB: Math.round(du(indexDir) / 1048576), exactWordsTableMB: +(fs.statSync(path.join(indexDir, 'words.bin')).size / 1048576).toFixed(2), engineFileMB: Math.round(du(path.join(indexDir, 'engine')) / 1048576),
  peakMemoryMB: { search: rss(['search', 'ferry rope', '--no-sync', '--json']), status: rss(['status', '--json']), syncNothingChanged: rss(['sync', '--json']) },
};
console.log(JSON.stringify(out, null, 2));
process.exit(0);
