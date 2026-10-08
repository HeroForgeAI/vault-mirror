#!/usr/bin/env node
// A second pass that was measured and not built in: the top passages of the blended list are scored again
// by a small model that reads the question and the passage together, and the list is put in that order.
// vault-mirror does not depend on what this needs. To repeat the measurement, in a clone:
//
//   npm install --no-save onnxruntime-node@1.30.0 @huggingface/tokenizers@0.2.0
//   mkdir -p <model dir> && cd <model dir>      # then save, from the model's page on huggingface.co:
//     onnx/model.onnx  as model.onnx,  tokenizer.json,  and tokenizer_config.json when the tokenizer is not WordPiece
//   VAULT_MIRROR_HOME=<home> node tests/bench/second-pass.mjs --model <model dir> --questions <file> [--questions <file>]
//
// It reads the index only and writes nothing. Models tried are listed in docs/BENCHMARKS.md.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { loadContext } from '../../src/cli/context.js';
import { loadManifest } from '../../src/store/manifest.js';
import { ensureEngine } from '../../src/engine/build.js';
import { createEmbedder } from '../../src/embed/embedder.js';
import { searchReady, loadWords } from '../../src/search/search.js';
import { createWordPiece } from '../../src/embed/wordpiece.js';

const { values: opt } = parseArgs({ options: { model: { type: 'string' }, questions: { type: 'string', multiple: true }, pool: { type: 'string', default: '20' }, threads: { type: 'string', default: '2' } } });
if (!opt.model || !opt.questions?.length) { console.error('Usage: node tests/bench/second-pass.mjs --model <model dir> --questions <file> [--pool 20] [--threads 2]'); process.exit(2); }
const require = createRequire(import.meta.url);
/** @type {any} */
let ort;
try { ort = require('onnxruntime-node'); } catch { console.error('This check needs onnxruntime-node, which vault-mirror does not depend on. See the top of this file.'); process.exit(2); }
const POOL = Number(opt.pool); const COUNT = 8; const MAX_TOKENS = 256;
const say = (/** @type {string} */ line) => fs.writeSync(1, line + '\n'); // the embedder keeps console output quiet while it is loaded

// The pair the model reads: question, then passage. BERT-style models mark the two parts; the other kind does not.
const tokenizer = JSON.parse(fs.readFileSync(path.join(opt.model, 'tokenizer.json'), 'utf8'));
const vocab = tokenizer.model.vocab;
const id = (/** @type {string} */ token) => vocab[token] ?? vocab['[UNK]'];
const bert = tokenizer.model.type === 'WordPiece';
const wordPiece = bert ? createWordPiece(tokenizer) : null;
const other = bert ? null : new (require('@huggingface/tokenizers').Tokenizer)(tokenizer, JSON.parse(fs.readFileSync(path.join(opt.model, 'tokenizer_config.json'), 'utf8')));
const plain = (/** @type {string} */ text) => (wordPiece ? wordPiece.tokenize(text).map(id) : other.encode(text).ids.slice(1, -1));
const pair = (/** @type {number[]} */ q, /** @type {number[]} */ p) => (bert
  ? { ids: [id('[CLS]'), ...q, id('[SEP]'), ...p, id('[SEP]')], types: [...new Array(q.length + 2).fill(0), ...new Array(p.length + 1).fill(1)] }
  : { ids: [0, ...q, 2, 2, ...p, 2], types: new Array(q.length + p.length + 4).fill(0) });

const before = process.memoryUsage().rss;
let t = performance.now();
const session = await ort.InferenceSession.create(path.join(opt.model, 'model.onnx'), { intraOpNumThreads: Number(opt.threads), interOpNumThreads: 1 });
const loadMs = performance.now() - t;
const modelMB = (process.memoryUsage().rss - before) / 1e6;

/** One score per passage, higher is closer. @param {string} question @param {string[]} passages */
async function scores(question, passages) {
  const q = plain(question).slice(0, 64);
  const rows = passages.map((p) => pair(q, plain(p).slice(0, MAX_TOKENS - q.length - 4)));
  const width = Math.max(...rows.map((r) => r.ids.length)); const n = rows.length;
  const ids = new BigInt64Array(n * width).fill(bert ? 0n : 1n); const mask = new BigInt64Array(n * width); const types = new BigInt64Array(n * width);
  rows.forEach((r, b) => r.ids.forEach((x, i) => { ids[b * width + i] = BigInt(x); mask[b * width + i] = 1n; types[b * width + i] = BigInt(r.types[i]); }));
  /** @type {Record<string, any>} */
  const feeds = { input_ids: new ort.Tensor('int64', ids, [n, width]), attention_mask: new ort.Tensor('int64', mask, [n, width]) };
  if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', types, [n, width]);
  return Array.from((await session.run(feeds))[session.outputNames[0]].data);
}

const ctx = loadContext({ needVault: true });
const loaded = loadManifest(ctx.indexDir);
if (!loaded) { console.error('Nothing is indexed yet. Run vault-mirror sync first.'); process.exit(2); }
const eng = await ensureEngine({ indexDir: ctx.indexDir, loaded, dimensions: Number(loaded.manifest.embedding.dimensions) });
const embedder = createEmbedder({ model: String(eng.loaded.manifest.embedding.model) });
await embedder.init();
const ready = { embedder, engine: eng.engine, manifest: eng.loaded.manifest, dataDir: eng.loaded.dataDir, words: loadWords(ctx.indexDir, eng.loaded, false) };

/** @type {{ kind: string, wordings: string[], wanted: string[] }[]} */
const questions = [];
for (const file of opt.questions) {
  for (const q of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    const wanted = [q.expected, ...(q.alternates || [])];
    const add = (/** @type {string} */ kind, /** @type {string} */ text) => questions.push({ kind, wordings: [text, ...(q.phrasings || [])], wanted });
    if (q.kind) add(q.kind, q.question); else { add('reworded', q.question); if (q.exact) add('own words', q.exact); }
  }
}
const kinds = [...new Set(questions.map((q) => q.kind)), 'all'];
const sorted = (/** @type {number[]} */ xs) => [...xs].sort((a, b) => a - b);
const pad = (/** @type {unknown} */ x, /** @type {number} */ n) => String(x).padEnd(n);
say(`${opt.model}: ${(fs.statSync(path.join(opt.model, 'model.onnx')).size / 1e6).toFixed(1)} MB on disk, loaded in ${loadMs.toFixed(0)} ms, ${modelMB.toFixed(0)} MB more memory once loaded; ${POOL} passages scored per question, ${opt.threads} threads`);

for (const wordings of [1, 3]) {
  /** @type {Record<string, Record<string, { n: number, top1: number, top3: number, top5: number, top8: number, printed: number, mrr: number, ndcg: number }>>} */
  const methods = { blended: {}, 'second pass': {}, 'second pass, mixed by place': {} };
  const ms = [];
  for (const q of questions) {
    const queries = q.wordings.slice(0, wordings);
    const base = await searchReady(ready, { queries, count: COUNT, vaultPath: ctx.vault.real, vaultParam: null });
    const pool = await searchReady(ready, { queries, count: POOL, vaultPath: ctx.vault.real, vaultParam: null });
    t = performance.now();
    const s = await scores(queries[0], pool.results.map((r) => `${r.note}. ${r.section ? `${r.section}. ` : ''}${r.text}`));
    ms.push(performance.now() - t);
    const again = pool.results.map((r, i) => ({ p: r.vaultPath, s: s[i], i })).sort((a, b) => b.s - a.s || a.i - b.i);
    // Mixed by place: the first list counts for more near the top, the second pass for more further down.
    const place = new Map(again.map((o, j) => [o.p, j]));
    const mixed = pool.results.map((r, i) => { const first = i < 3 ? 0.75 : i < 10 ? 0.6 : 0.4; return { p: r.vaultPath, s: first / (i + 1) + (1 - first) / ((place.get(r.vaultPath) ?? 0) + 1), i }; }).sort((a, b) => b.s - a.s || a.i - b.i);
    const outs = { blended: [...base.results, ...base.exactWords].map((x) => x.vaultPath), 'second pass': again.slice(0, COUNT).map((o) => o.p), 'second pass, mixed by place': mixed.slice(0, COUNT).map((o) => o.p) };
    for (const [name, raw] of Object.entries(outs)) {
      const out = [...new Set(raw)];
      const first = out.findIndex((p) => q.wanted.includes(p));
      let dcg = 0; let ideal = 0;
      out.slice(0, 10).forEach((p, i) => { if (q.wanted.includes(p)) dcg += 1 / Math.log2(i + 2); });
      for (let i = 0; i < Math.min(q.wanted.length, 10); i++) ideal += 1 / Math.log2(i + 2);
      for (const key of [q.kind, 'all']) {
        const a = methods[name][key] || (methods[name][key] = { n: 0, top1: 0, top3: 0, top5: 0, top8: 0, printed: 0, mrr: 0, ndcg: 0 });
        a.n++;
        if (first >= 0) { a.printed++; if (first < 1) a.top1++; if (first < 3) a.top3++; if (first < 5) a.top5++; if (first < 8) a.top8++; if (first < 10) a.mrr += 1 / (first + 1); }
        a.ndcg += dcg / ideal;
      }
    }
  }
  const times = sorted(ms);
  say(`\n${wordings === 1 ? 'One wording' : 'Three wordings in one call'}. The second pass took ${times[Math.floor(times.length / 2)].toFixed(0)} ms per question (median; 9 in 10 under ${times[Math.floor(times.length * 0.9)].toFixed(0)} ms).`);
  say(`${pad('kind', 12)}${pad('method', 30)}${pad('of', 5)}${pad('top 1', 7)}${pad('top 3', 7)}${pad('top 5', 7)}${pad('top 8', 7)}${pad('printed', 9)}${pad('MRR@10', 8)}nDCG@10`);
  for (const kind of kinds) for (const [name, agg] of Object.entries(methods)) { const a = agg[kind]; say(`${pad(kind, 12)}${pad(name, 30)}${pad(a.n, 5)}${pad(a.top1, 7)}${pad(a.top3, 7)}${pad(a.top5, 7)}${pad(a.top8, 7)}${pad(a.printed, 9)}${pad((a.mrr / a.n).toFixed(3), 8)}${(a.ndcg / a.n).toFixed(3)}`); }
}
say(`\nPeak memory of this process: ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB`);
await embedder.shutdown();
process.exit(0);
