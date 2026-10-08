#!/usr/bin/env node
// The ranking check: asks every question of a labelled list against the current vault's index, in one
// process, and scores what a search would print. It compares the two lists kept apart (vault-mirror 0.1.1 and earlier)
// with the blended list, and, for the record, with plain reciprocal rank fusion, which was tried and not kept.
// It reads the index only. It never syncs, and it writes nothing unless --out is given.
//
//   VAULT_MIRROR_HOME=<home> node tests/bench/ranking.mjs --questions <file> [--questions <file>] [--check <vault>] [--out <file>]
//
// A question file is a JSON array. Each entry has `expected` (a vault path), optional `alternates`, optional
// `phrasings` (two more wordings), and either `kind` + `question`, or `question` + `exact` (the older list:
// counted as the kinds "reworded" and "own words").
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadContext } from '../../src/cli/context.js';
import { loadManifest } from '../../src/store/manifest.js';
import { readRecord } from '../../src/store/sidecar.js';
import { ensureEngine } from '../../src/engine/build.js';
import { parseId } from '../../src/engine/engine.js';
import { createEmbedder } from '../../src/embed/embedder.js';
import { searchReady, loadWords, collapse } from '../../src/search/search.js';
import { exactWordCandidates } from '../../src/search/exact-words.js';
import { readQuestion, tokenise } from '../../src/words/tokens.js';

const { values: opt } = parseArgs({ options: { questions: { type: 'string', multiple: true }, check: { type: 'string' }, out: { type: 'string' }, count: { type: 'string' } } });
if (!opt.questions?.length) { console.error('Usage: node tests/bench/ranking.mjs --questions <file> [--questions <file>] [--check <vault>] [--out <file>]'); process.exit(2); }
const COUNT = Number(opt.count || 8);

/** @type {{ file: string, n: number, kind: string, wordings: string[], wanted: string[] }[]} */
const questions = [];
for (const file of opt.questions) {
  for (const q of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    const wanted = [q.expected, ...(q.alternates || [])];
    const add = (/** @type {string} */ kind, /** @type {string} */ text) => questions.push({ file: path.basename(file), n: q.n, kind, wordings: [text, ...(q.phrasings || [])], wanted });
    if (q.kind) add(q.kind, q.question); else { add('reworded', q.question); if (q.exact) add('own words', q.exact); }
  }
}

// --check: is every "far" question free of the note's words, and is every "exact" lookup in its note?
if (opt.check) {
  let bad = 0;
  for (const q of questions) {
    if (q.kind !== 'far' && q.kind !== 'exact') continue;
    const text = `${q.wanted[0]}\n${fs.readFileSync(path.join(opt.check, q.wanted[0]), 'utf8')}`;
    if (q.kind === 'far') {
      const have = new Set(tokenise(text));
      const shared = readQuestion(q.wordings[0]).words.filter((w) => have.has(w));
      if (shared.length) { bad++; console.log(`far #${q.n} shares ${shared.join(', ')} with its note`); }
    } else if (!text.toLowerCase().includes(q.wordings[0].toLowerCase())) { bad++; console.log(`exact #${q.n} is not in its note word for word`); }
  }
  console.log(`check: ${bad} of ${questions.filter((q) => q.kind === 'far' || q.kind === 'exact').length} far and exact questions break their rule`);
}

const ctx = loadContext({ needVault: true });
const loaded = loadManifest(ctx.indexDir);
if (!loaded) { console.error('Nothing is indexed yet. Run vault-mirror sync first.'); process.exit(2); }
const eng = await ensureEngine({ indexDir: ctx.indexDir, loaded, dimensions: Number(loaded.manifest.embedding.dimensions) });
const { manifest, dataDir } = eng.loaded;
const embedder = createEmbedder({ model: String(manifest.embedding.model) });
await embedder.init();
const words = loadWords(ctx.indexDir, eng.loaded, false);
const ready = { embedder, engine: eng.engine, manifest, dataDir, words };
const names = Object.keys(manifest.notes);
const known = (/** @type {string} */ id) => { const { path: p, n } = parseId(id); const e = manifest.notes[p]; return Boolean(e) && n >= 0 && n < e.passages; };

/** What a search prints, as note paths in order: the ranked list, then the exact-words list. @param {string[]} queries @param {boolean} blend */
async function printed(queries, blend) {
  const r = await searchReady(ready, { queries, count: COUNT, vaultPath: ctx.vault.real, vaultParam: null, blend });
  return [...r.results, ...r.exactWords].map((x) => x.vaultPath);
}

/**
 * Plain reciprocal rank fusion of the two lists, 1 / (60 + rank) each, 50 notes deep. Tried, measured, not kept.
 * @param {string[]} queries
 */
async function fused(queries) {
  const hits = [];
  for (const q of queries) hits.push(await eng.engine.search(await embedder.embedQuery(q), 400));
  const meaning = collapse(hits, known).slice(0, 50).map((h) => h.path);
  /** @type {Map<number, any>} */
  const records = new Map();
  const record = (/** @type {number} */ i) => { let r = records.get(i); if (!r) { r = readRecord(dataDir, manifest.notes[names[i]].log); records.set(i, r); } return r; };
  const all = words ? exactWordCandidates(words, record, queries, { perWording: 50 }) : [];
  all.sort((a, b) => a.place - b.place || b.score - a.score || a.wording - b.wording);
  const byWords = [...new Set(all.map((h) => names[h.note]))].slice(0, 50);
  /** @type {Map<string, number>} */
  const score = new Map();
  for (const list of [meaning, byWords]) list.forEach((p, i) => score.set(p, (score.get(p) || 0) + 1 / (60 + i + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1] || meaning.indexOf(a[0]) - meaning.indexOf(b[0]) || (a[0] < b[0] ? -1 : 1)).slice(0, COUNT).map((x) => x[0]);
}

const METHODS = /** @type {[string, (queries: string[]) => Promise<string[]>][]} */ ([
  ['two lists (0.1.1)', (q) => printed(q, false)],
  ['blended', (q) => printed(q, true)],
  ['plain rank fusion (not kept)', fused],
]);
const kinds = [...new Set(questions.map((q) => q.kind))];
/** @type {Record<string, any>} */
const report = { machine: `${os.cpus()[0].model}, ${os.cpus().length} cores`, node: process.version, vault: { notes: manifest.totals.notes, passages: manifest.totals.passages }, questions: questions.length, count: COUNT, rows: [], moved: [] };
const median = (/** @type {number[]} */ xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

for (const wordings of [1, 3]) {
  /** @type {Record<string, (number | null)[]>} */
  const places = {};
  for (const [name, run] of METHODS) {
    /** @type {Record<string, { n: number, top1: number, top3: number, top5: number, top8: number, printed: number, mrr: number, ndcg: number }>} */
    const agg = {};
    const ms = []; places[name] = [];
    for (const q of questions) {
      const t = performance.now();
      const out = [...new Set(await run(q.wordings.slice(0, wordings)))];
      ms.push(performance.now() - t);
      const first = out.findIndex((p) => q.wanted.includes(p));
      places[name].push(first < 0 ? null : first + 1);
      let dcg = 0; let ideal = 0;
      out.slice(0, 10).forEach((p, i) => { if (q.wanted.includes(p)) dcg += 1 / Math.log2(i + 2); });
      for (let i = 0; i < Math.min(q.wanted.length, 10); i++) ideal += 1 / Math.log2(i + 2);
      for (const key of [q.kind, 'all']) {
        const a = agg[key] || (agg[key] = { n: 0, top1: 0, top3: 0, top5: 0, top8: 0, printed: 0, mrr: 0, ndcg: 0 });
        a.n++;
        if (first >= 0) { a.printed++; if (first < 1) a.top1++; if (first < 3) a.top3++; if (first < 5) a.top5++; if (first < 8) a.top8++; if (first < 10) a.mrr += 1 / (first + 1); }
        a.ndcg += dcg / ideal;
      }
    }
    for (const key of [...kinds, 'all']) {
      const a = agg[key];
      report.rows.push({ wordings, method: name, kind: key, of: a.n, top1: a.top1, top3: a.top3, top5: a.top5, top8: a.top8, printed: a.printed, mrr10: +(a.mrr / a.n).toFixed(3), ndcg10: +(a.ndcg / a.n).toFixed(3), warmMsMedian: key === 'all' ? +median(ms).toFixed(1) : undefined });
    }
  }
  questions.forEach((q, i) => { const a = places[METHODS[0][0]][i]; const b = places[METHODS[1][0]][i]; if (a !== b) report.moved.push({ wordings, kind: q.kind, n: q.n, file: q.file, twoLists: a, blended: b }); });
}
await embedder.shutdown();
report.loadAtEnd = os.loadavg().map((x) => +x.toFixed(1));

const pad = (/** @type {unknown} */ x, /** @type {number} */ n) => String(x).padEnd(n);
for (const wordings of [1, 3]) {
  console.log(`\n${wordings === 1 ? 'One wording' : 'Three wordings in one call'}. Place of the first right note in what is printed (${COUNT} results, then the exact-words list).`);
  console.log(`${pad('kind', 12)}${pad('method', 30)}${pad('of', 5)}${pad('top 1', 7)}${pad('top 3', 7)}${pad('top 5', 7)}${pad('top 8', 7)}${pad('printed', 9)}${pad('MRR@10', 8)}nDCG@10`);
  for (const r of report.rows.filter((/** @type {any} */ x) => x.wordings === wordings)) console.log(`${pad(r.kind, 12)}${pad(r.method, 30)}${pad(r.of, 5)}${pad(r.top1, 7)}${pad(r.top3, 7)}${pad(r.top5, 7)}${pad(r.top8, 7)}${pad(r.printed, 9)}${pad(r.mrr10.toFixed(3), 8)}${r.ndcg10.toFixed(3)}`);
  console.log(`warm time per question, median: ${report.rows.filter((/** @type {any} */ x) => x.wordings === wordings && x.kind === 'all').map((/** @type {any} */ x) => `${x.method} ${x.warmMsMedian} ms`).join('; ')}`);
}
const up = report.moved.filter((/** @type {any} */ m) => (m.blended ?? 99) < (m.twoLists ?? 99)).length;
console.log(`\nBlended against two lists: the right note moved up in ${up} searches and down in ${report.moved.length - up}. Load average at the end: ${report.loadAtEnd.join(' ')}`);
for (const m of report.moved.filter((/** @type {any} */ x) => (x.blended ?? 99) > (x.twoLists ?? 99))) console.log(`  down: ${m.kind} #${m.n} (${m.file}), ${m.wordings === 1 ? 'one wording' : 'three wordings'}: place ${m.twoLists} -> ${m.blended ?? 'not printed'}`);
if (opt.out) fs.writeFileSync(opt.out, JSON.stringify(report, null, 2) + '\n');
process.exit(0);
