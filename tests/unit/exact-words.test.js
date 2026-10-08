import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { configureWriter } from '../../src/store/safe-write.js';
import { createDataDir, openSidecar } from '../../src/store/sidecar.js';
import { newManifest, saveManifest, switchCurrent } from '../../src/store/manifest.js';
import { tokenise, isDistinctive, hashToken, readQuestion, hasPhrase, passageFields, STOP_WORDS } from '../../src/words/tokens.js';
import { buildTable, encodeTable, decodeTable, decodeHead, sameWords, noteWords, noteKey } from '../../src/words/table.js';
import { findWords, rankPassages, idf, termScore } from '../../src/words/bm25.js';
import { wordsFor, wordsAtStamp, checkWords, readWords, dropWords, WORDS_FILE } from '../../src/words/store.js';
import { exactWordHits, notAlreadyShown } from '../../src/search/exact-words.js';
import { searchReady } from '../../src/search/search.js';
import { remakeWords } from '../../src/cli/commands/rebuild.js';
import { createExact } from '../../src/engine/exact.js';
import { passageId } from '../../src/engine/engine.js';
import { tmpDir } from '../helpers/tmp.mjs';

const CHUNKER = { version: 1, settingsHash: 'x' };
/** @param {string} title @param {(string | { trail: string[], text: string })[]} passages */
const rec = (title, passages) => ({ title, passages: passages.map((p) => (typeof p === 'string' ? { trail: [], text: p } : p)) });
/** @param {Record<string, ReturnType<typeof rec>>} notes @param {import('../../src/words/table.js').WordsTable | null} [old] */
function tableOf(notes, old = null) {
  const names = Object.keys(notes);
  let reads = 0;
  const built = buildTable({ stamp: 's:1', chunker: CHUNKER, old, notes: names.map((p) => ({ path: p, sha256: JSON.stringify(notes[p]), passages: notes[p].passages.length })), readNote: (i) => { reads++; return notes[names[i]]; } });
  return { ...built, names, reads };
}

// --- tokenising ---

test('tokens: lower-case runs of letters and digits; everything else ends a token', () => {
  assert.deepEqual(tokenise('The Garden-Plan, v2: "Tomatoes" (3kg)!'), ['the', 'garden', 'plan', 'v2', 'tomatoes', '3kg']);
  assert.deepEqual(tokenise("garden's don’t"), ['garden', 's', 'don', 't']);
  assert.deepEqual(tokenise('Café 北京 naïve Ünïcode'), ['café', '北京', 'naïve', 'ünïcode']);
  assert.deepEqual(tokenise('a𝒳b'), ['a𝒳b'], 'a letter outside the basic plane stays inside its word');
  assert.deepEqual(tokenise(''), []);
  assert.deepEqual(tokenise(' \n\t--- '), []);
  assert.deepEqual(tokenise(`key ${'x'.repeat(65)} end`), ['key', 'end'], 'a run longer than 64 is not a word');
  assert.deepEqual(tokenise('end of text'), ['end', 'of', 'text'], 'the last token is not lost');
});

test('distinctive words: stop words and single letters are left out, digits are kept', () => {
  assert.ok(STOP_WORDS.has('the') && STOP_WORDS.has('how') && STOP_WORDS.has('don'));
  assert.deepEqual(['how', 'do', 'i', 'plant', 'the', 'tomatoes', 's', 't', '8', 'x'].filter(isDistinctive), ['plant', 'tomatoes', '8']);
});

test('the same rules read a question and a passage', () => {
  const question = readQuestion('When do I plant TOMATOES?');
  const passage = tokenise('Start the Tomatoes indoors; plant out in May.');
  for (const w of question.words) assert.ok(passage.includes(w), `${w} is found in the passage`);
  assert.equal(hashToken('tomatoes'), hashToken(tokenise('TOMATOES!')[0]));
  assert.notEqual(hashToken('tomato'), hashToken('tomatoes'), 'no stemming: these are exact words');
  assert.ok(Number.isInteger(hashToken('é')) && hashToken('é') >= 0 && hashToken('é') <= 0xffffffff);
});

test('a question: distinctive words once each, quoted phrases kept whole', () => {
  assert.deepEqual(readQuestion('when is the "last frost" date for the last frost'), { words: ['last', 'frost', 'date'], phrases: [['last', 'frost']] });
  assert.deepEqual(readQuestion('“vitamin D” dose').phrases, [['vitamin', 'd']], 'curly quotes; a stop word or single letter stays inside a phrase');
  assert.deepEqual(readQuestion('to "be or not" to').phrases, [], 'a phrase with no distinctive word is not a phrase');
  assert.deepEqual(readQuestion('an "unfinished quote').phrases, []);
  assert.deepEqual(readQuestion('"HNSW"'), { words: ['hnsw'], phrases: [['hnsw']] });
  assert.deepEqual(readQuestion('how do I do it'), { words: [], phrases: [] });
});

test('a phrase means neighbours, in order', () => {
  const tokens = tokenise('the last hard frost, then the last frost date');
  assert.ok(hasPhrase(tokens, ['last', 'frost']));
  assert.ok(hasPhrase(tokens, ['frost', 'date']));
  assert.ok(!hasPhrase(tokens, ['frost', 'last']));
  assert.ok(!hasPhrase(tokens, ['hard', 'date']));
  assert.ok(!hasPhrase(['frost'], ['frost', 'date']));
  assert.deepEqual(passageFields({ title: 'T' }, { trail: ['A', 'B'], text: 'body' }), ['T', 'A', 'B', 'body']);
});

// --- the table ---

const NOTES = {
  'Garden/Tomatoes.md': rec('Tomatoes', ['Start the tomatoes indoors six weeks before the last frost.', { trail: ['Watering'], text: 'Water the tomatoes at the root, never on the leaves. Tomatoes hate wet leaves.' }]),
  'Garden/Beans.md': rec('Beans', ['Sow beans after the last frost date, when the soil is warm.']),
  'Kitchen/Soup.md': rec('Soup', ['Simmer the stock for two hours.', 'Add the beans near the end.', 'Salt at the table.']),
};

test('the table: one row of words per passage, counted without stop words', () => {
  const w = noteWords(NOTES['Garden/Tomatoes.md']);
  assert.deepEqual(w.docLen, [8, 11], 'title, heading trail and text all count');
  assert.equal(w.docTerms[1], 8, 'distinct words of the second passage');
  const at = w.docTerms[0] + w.hash.slice(w.docTerms[0]).indexOf(hashToken('tomatoes'));
  assert.equal(w.tf[at], 3, 'title once and text twice');
  const { table } = tableOf(NOTES);
  assert.equal(table.notes, 3); assert.equal(table.passages, 6);
  assert.deepEqual([...table.notePassages], [2, 1, 3]);
  assert.equal(table.docEnd[5], table.termHash.length);
  assert.equal(table.sumLen, [...table.docLen].reduce((a, b) => a + b, 0));
});

test('the table file: round trip; no text and no note name inside; damaged bytes are refused', () => {
  const { table } = tableOf(NOTES);
  const bytes = encodeTable(table);
  const back = decodeTable(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.ok(back && sameWords(back, table));
  assert.equal(back.stamp, 's:1'); assert.deepEqual(back.chunker, CHUNKER);
  const text = Buffer.from(bytes).toString('latin1');
  for (const word of ['tomatoes', 'Tomatoes', 'Garden', 'frost', 'Soup']) assert.ok(!text.includes(word), `${word} is not in the file`);
  assert.equal(decodeHead(bytes)?.head.passages, 6);
  assert.equal(decodeTable(bytes.buffer.slice(0, bytes.length - 1)), null, 'a file cut short');
  assert.equal(decodeTable(new ArrayBuffer(0)), null);
  assert.equal(decodeTable(new TextEncoder().encode('not a table at all, just text').buffer), null);
  const other = encodeTable(table); other[0] ^= 1;
  assert.equal(decodeTable(other.buffer), null, 'another kind of file');
  assert.equal(decodeTable(encodeTable(tableOf({}).table).buffer)?.passages, 0, 'an empty table is a table');
});

test('the table follows the notes: unchanged notes are copied, changed ones are read again', () => {
  const first = tableOf(NOTES);
  assert.equal(first.read, 3);
  const same = tableOf(NOTES, first.table);
  assert.equal(same.reads, 0); assert.equal(same.reused, 3);
  assert.ok(sameWords(same.table, first.table));

  const edited = { 'Garden/Beans.md': rec('Beans', ['Sow beans in May.', 'Pick them young.']), 'Kitchen/Soup.md': NOTES['Kitchen/Soup.md'], 'New.md': rec('New', ['A brand new note about quinces.']) };
  const next = tableOf(edited, first.table);
  assert.equal(next.reused, 1, 'only the soup note was unchanged'); assert.equal(next.reads, 2);
  assert.ok(sameWords(next.table, tableOf(edited).table), 'the same table as one made from nothing');
  assert.ok(!sameWords(next.table, first.table));

  const otherRules = buildTable({ stamp: 's:2', chunker: { version: 2, settingsHash: 'x' }, old: first.table, notes: first.names.map((p) => ({ path: p, sha256: JSON.stringify(NOTES[p]), passages: NOTES[p].passages.length })), readNote: (i) => NOTES[first.names[i]] });
  assert.equal(otherRules.reused, 0, 'a table made with another chunker is not copied from');
  assert.throws(() => buildTable({ stamp: 's', chunker: CHUNKER, notes: [{ path: 'A.md', sha256: 'a', passages: 2 }], readNote: () => rec('A', ['only one']) }), /does not hold the passages/);
});

test('the table reads a note again when its folder joins or leaves the prefix (same content, same count, other cuts)', () => {
  // A second note with the same file name appears: the first is cut again with a smaller budget. Its
  // content hash and its passage count can both stay the same while the passages themselves change.
  const before = rec('Log', ['kestrel heron wagtail', 'curlew gannet']);
  const after = rec('Log', ['kestrel heron', 'wagtail curlew gannet']);
  const note = (/** @type {boolean} */ fip) => [{ path: 'A/Log.md', sha256: 'same-content', passages: 2, folderInPrefix: fip }];
  const first = buildTable({ stamp: 's:1', chunker: CHUNKER, notes: note(false), readNote: () => before });
  let reads = 0;
  const next = buildTable({ stamp: 's:2', chunker: CHUNKER, old: first.table, notes: note(true), readNote: () => { reads++; return after; } });
  assert.equal(reads, 1, 'the note is read again, not copied'); assert.equal(next.reused, 0);
  const fresh = buildTable({ stamp: 's:2', chunker: CHUNKER, notes: note(true), readNote: () => after });
  assert.ok(sameWords(next.table, fresh.table), 'the same table as one made from nothing');
  assert.ok(!sameWords(next.table, first.table), 'and not the old rows');
  const still = buildTable({ stamp: 's:3', chunker: CHUNKER, old: next.table, notes: note(true), readNote: () => { throw new Error('must not be read'); } });
  assert.equal(still.reused, 1, 'an unchanged flag still copies');
  assert.ok(!Buffer.from(noteKey('A/Log.md', 'h', 2, false)).equals(Buffer.from(noteKey('A/Log.md', 'h', 2, true))), 'the key itself differs');
});

// --- scoring ---

test('BM25: the formula, by hand', () => {
  assert.equal(idf(10, 10), Math.log(1 + 0.5 / 10.5));
  assert.ok(idf(1000, 1) > idf(1000, 100) && idf(1000, 100) > idf(1000, 999) && idf(1000, 1000) > 0, 'rarer is worth more, and never negative');
  assert.equal(termScore(2, 1, 10, 10), 2 * 2.2 / (1 + 1.2), 'tf 1 in a passage of average length scores the weight itself');
  assert.ok(Math.abs(termScore(2, 1, 10, 10) - 2) < 1e-12);
  assert.ok(termScore(1, 3, 10, 10) > termScore(1, 1, 10, 10) && termScore(1, 3, 10, 10) < 2.2, 'more uses help, with a ceiling');
  assert.ok(termScore(1, 1, 5, 10) > termScore(1, 1, 20, 10), 'a shorter passage scores higher for the same use');
});

test('BM25: ranks a small store as worked out by hand', () => {
  const { table } = tableOf(NOTES);
  const words = ['tomatoes', 'frost', 'beans', 'zebra'];
  const found = findWords(table, words.map(hashToken));
  assert.deepEqual([...found.df], [2, 2, 2, 0]);
  const ranked = rankPassages(table, found, [0, 1]); // "tomatoes frost"
  assert.deepEqual(ranked.map((r) => r.passage), [0, 1, 2], 'both words, then tomatoes three times, then frost alone');
  const avg = table.sumLen / 6; const w = idf(6, 2);
  assert.ok(Math.abs(ranked[0].score - (termScore(w, 2, table.docLen[0], avg) + termScore(w, 1, table.docLen[0], avg))) < 1e-9);
  assert.ok(Math.abs(ranked[1].score - termScore(w, 3, table.docLen[1], avg)) < 1e-9);
  assert.deepEqual(rankPassages(table, found, [3]), [], 'a word no passage holds finds nothing');
  assert.deepEqual(rankPassages(table, found, [2]).map((r) => r.passage), [2, 4], 'beans: twice in passage 2 beats once in passage 4');
  assert.deepEqual(rankPassages(table, found, [0, 1], [0, 1]).map((r) => r.passage), [0], 'required words: only the passage that holds them all');
  const twins = tableOf({ 'A.md': rec('', ['quince jam']), 'B.md': rec('', ['quince jam']) }).table;
  assert.deepEqual(rankPassages(twins, findWords(twins, [hashToken('quince')]), [0]).map((r) => r.passage), [0, 1], 'a tie goes to the earlier passage');
});

// --- the list ---

test('the exact-words list: one passage per note, best first, with the words that were found', () => {
  const { table, names } = tableOf(NOTES);
  const read = (/** @type {number} */ i) => NOTES[names[i]];
  const hits = exactWordHits(table, read, ['how should I water my tomatoes']);
  assert.deepEqual(hits.map((h) => [names[h.note], h.n, h.words]), [['Garden/Tomatoes.md', 1, ['water', 'tomatoes']]]);
  assert.deepEqual(exactWordHits(table, read, ['how do I do it']), [], 'a question of stop words has no exact words');
  assert.deepEqual(exactWordHits(table, read, ['zebra crossing']), []);
  assert.deepEqual(exactWordHits(tableOf({}).table, read, ['tomatoes']), []);
});

test('the exact-words list: a quoted phrase counts as a phrase', () => {
  const notes = {
    'A.md': rec('A', ['The frost came last week and the last of the apples fell.']),
    'B.md': rec('B', ['Plant out after the last frost.']),
    'C.md': rec('Last', [{ trail: [], text: 'Frost is rare here.' }]),
  };
  const { table, names } = tableOf(notes);
  const read = (/** @type {number} */ i) => notes[names[i]];
  assert.deepEqual(exactWordHits(table, read, ['last frost']).map((h) => names[h.note]).sort(), ['A.md', 'B.md', 'C.md'], 'as plain words, all three match');
  assert.deepEqual(exactWordHits(table, read, ['when is the "last frost"']).map((h) => names[h.note]), ['B.md'], 'as a phrase, only the one that says it; a title next to its text is not a phrase');
  assert.deepEqual(exactWordHits(table, read, ['"last frost" and "apples fell"']), [], 'every phrase of a wording must be there');
  assert.deepEqual(exactWordHits(table, read, ['“after the last frost”']).map((h) => names[h.note]), ['B.md'], 'stop words inside a phrase count');
});

test('the exact-words list: each wording contributes', () => {
  const notes = Object.fromEntries(['quince', 'medlar', 'damson'].flatMap((fruit) => [1, 2, 3, 4].map((i) => [`${fruit} ${i}.md`, rec('', [`${`${fruit} `.repeat(5 - i)}jam recipe number ${i}`])])));
  const { table, names } = tableOf(notes);
  const read = (/** @type {number} */ i) => notes[names[i]];
  const one = exactWordHits(table, read, ['quince']);
  assert.deepEqual(one.map((h) => names[h.note]), ['quince 1.md', 'quince 2.md', 'quince 3.md'], 'three per wording');
  const three = exactWordHits(table, read, ['quince', 'medlar', 'damson']);
  assert.deepEqual(three.slice(0, 3).map((h) => names[h.note]).sort(), ['damson 1.md', 'medlar 1.md', 'quince 1.md'], 'the best of each wording comes before the second best of any');
  assert.equal(three.length, 9);
  const twice = exactWordHits(table, read, ['quince', 'quince jam']);
  assert.equal(new Set(twice.map((h) => h.note)).size, twice.length, 'a note found by two wordings is listed once');
});

test('the exact-words list reports only words that are really in the passage', () => {
  const notes = { 'A.md': rec('', ['quince jam']) };
  const { table, names } = tableOf(notes);
  // The table says the passage holds this word (as a clash of two hashes would); the passage itself does not.
  const lying = { ...table, termHash: Uint32Array.from(table.termHash, (h) => (h === hashToken('quince') ? hashToken('zebra') : h)) };
  assert.deepEqual(exactWordHits(lying, (i) => notes[names[i]], ['zebra']), []);
  assert.deepEqual(exactWordHits(lying, (i) => notes[names[i]], ['zebra jam']).map((h) => h.words), [['jam']]);
});

test('passages the list by meaning already shows are left out, and the list stays short', () => {
  const hits = ['A.md#0', 'B.md#2', 'C.md#1', 'D.md#0', 'E.md#0'].map((passage) => ({ passage }));
  assert.deepEqual(notAlreadyShown(hits, [{ passage: 'B.md#2' }]).map((h) => h.passage), ['A.md#0', 'C.md#1', 'D.md#0']);
  assert.deepEqual(notAlreadyShown(hits.slice(0, 2), [{ passage: 'A.md#0' }, { passage: 'B.md#2' }]), [], 'nothing new: the list is left out');
  assert.deepEqual(notAlreadyShown(hits, [{ passage: 'B.md#0' }]).length, 3, 'another passage of a shown note is still new');
});

// --- the file in the index folder, and the search path ---

const DIMS = 4;
/** An index folder holding these notes, made with the tool's own store code. @param {Record<string, ReturnType<typeof rec>>} notes @param {(key: string, n: number) => number[]} [vectorOf] */
function indexOf(notes, vectorOf = () => [1, 0, 0, 0]) {
  const home = tmpDir('words');
  configureWriter({ home });
  const indexDir = path.join(home, 'indexes', 'v-00000000');
  const dataDir = path.join(indexDir, 'data-0001');
  const manifest = newManifest({ dataName: 'data-0001', vault: { name: 'v', path: '/nowhere/v', pathHash: '00000000' }, chunker: { version: 1, settingsHash: 'x', budgetTokens: 10, counter: 'fake' }, embedding: { model: 'fake', dimensions: DIMS }, engine: {} });
  manifest.sidecar.logBytes = createDataDir(dataDir, {});
  const s = { home, indexDir, dataDir, manifest };
  commit(s, notes, vectorOf);
  switchCurrent(indexDir, 'data-0001');
  return s;
}
/** @param {any} s @param {Record<string, ReturnType<typeof rec>>} notes @param {(key: string, n: number) => number[]} [vectorOf] */
function commit(s, notes, vectorOf = () => [1, 0, 0, 0]) {
  const side = openSidecar(s.dataDir, s.manifest.sidecar, DIMS);
  const keys = Object.keys(notes);
  const where = side.appendPuts(keys.map((key) => ({
    record: { v: /** @type {1} */ (1), op: /** @type {'put'} */ ('put'), path: key, sha256: `sha:${JSON.stringify(notes[key])}`, size: 1, mtimeMs: 1, fip: false, title: notes[key].title, passages: notes[key].passages.map((p, n) => ({ n, trail: p.trail, line: n + 1, text: p.text, flags: [] })) },
    vectors: notes[key].passages.map((_, n) => Float32Array.from(vectorOf(key, n))),
  })));
  keys.forEach((key, i) => { s.manifest.notes[key] = { sha256: `sha:${JSON.stringify(notes[key])}`, size: 1, mtimeMs: 1, racy: false, passages: notes[key].passages.length, folderInPrefix: false, log: where[i].log, vec: where[i].vec, flagged: 0 }; });
  s.manifest.sidecar.logBytes = side.logBytes; s.manifest.sidecar.vectors = side.vectors;
  side.close();
  saveManifest(s.dataDir, s.manifest);
}

test('the saved table: made once, used as it is, brought in step after a change, checked note by note', () => {
  const s = indexOf(NOTES);
  const file = path.join(s.indexDir, WORDS_FILE);
  assert.deepEqual(checkWords(s.indexDir, s.manifest), { ok: false, passages: 0, notes: 0 }, 'no table yet');
  assert.equal(wordsAtStamp(s.indexDir, s.manifest), false);
  assert.equal(wordsFor(s.indexDir, s, {}).how, 'built');
  assert.ok(!fs.existsSync(file), 'nothing is written unless asked');
  const made = wordsFor(s.indexDir, s, { save: true });
  assert.equal(made.how, 'built'); assert.equal(made.read, 3);
  assert.deepEqual(checkWords(s.indexDir, s.manifest), { ok: true, passages: 6, notes: 3 });
  assert.equal(wordsAtStamp(s.indexDir, s.manifest), true, 'made from this very manifest');
  const size = fs.statSync(file).size;
  assert.ok(size < 2048, `a few bytes per word: ${size}`);
  assert.deepEqual({ ...wordsFor(s.indexDir, s, { save: true }), table: null }, { table: null, how: 'used', read: 0 });
  assert.deepEqual(fs.readdirSync(s.indexDir).filter((f) => f.includes('.tmp-')), [], 'no temp file is left');

  commit(s, { 'Garden/Beans.md': rec('Beans', ['Sow beans in May.', 'Pick them young.']) });
  assert.deepEqual(checkWords(s.indexDir, s.manifest), { ok: false, passages: 6, notes: 3 }, 'the table is behind, and says what it holds');
  assert.equal(wordsAtStamp(s.indexDir, s.manifest), false);
  const inMemory = wordsFor(s.indexDir, s, {});
  assert.equal(inMemory.how, 'updated'); assert.equal(inMemory.read, 1, 'only the changed note is read');
  assert.equal(inMemory.table.passages, 7);
  assert.equal(checkWords(s.indexDir, s.manifest).ok, false, 'a reader that was not asked to save leaves the file alone');
  wordsFor(s.indexDir, s, { save: true });
  assert.deepEqual(checkWords(s.indexDir, s.manifest), { ok: true, passages: 7, notes: 3 });
  assert.ok(sameWords(/** @type {any} */ (readWords(s.indexDir)), wordsFor(s.indexDir, s, { fresh: true }).table), 'equal to one made again from the saved passages');

  delete s.manifest.notes['Kitchen/Soup.md']; saveManifest(s.dataDir, s.manifest);
  assert.equal(checkWords(s.indexDir, s.manifest).ok, false, 'a removed note');
  assert.equal(wordsFor(s.indexDir, s, { save: true }).table.notes, 2);
  assert.equal(checkWords(s.indexDir, s.manifest).ok, true);
  s.manifest.notes['Garden/Beans.md'].sha256 = 'other';
  assert.equal(checkWords(s.indexDir, s.manifest).ok, false, 'the same passage count with other content is still a change');

  fs.writeFileSync(file, 'garbage');
  assert.equal(readWords(s.indexDir), null);
  assert.equal(checkWords(s.indexDir, s.manifest).ok, false);
  assert.equal(wordsFor(s.indexDir, s, { save: true }).how, 'built', 'a damaged table is made again');
  dropWords(s.indexDir);
  assert.ok(!fs.existsSync(file));
});

test('rebuild: a saved passage that cannot be read never throws; the table is removed and the caller is told', async () => {
  const s = indexOf(NOTES);
  const file = path.join(s.indexDir, WORDS_FILE);
  assert.equal(await remakeWords(s.indexDir, s), true);
  assert.equal(checkWords(s.indexDir, s.manifest).ok, true, 'made again from the saved passages');

  // One record no longer parses (same length, so every other record is still where the manifest says).
  const at = s.manifest.notes[Object.keys(s.manifest.notes)[0]].log;
  const fd = fs.openSync(path.join(s.dataDir, 'passages.jsonl'), 'r+'); fs.writeSync(fd, 'X', at[0]); fs.closeSync(fd);
  assert.throws(() => wordsFor(s.indexDir, s, { fresh: true }), 'the store itself still refuses the record');
  assert.equal(await remakeWords(s.indexDir, s), false, 'rebuild is told, and does not throw');
  assert.ok(!fs.existsSync(file), 'a table that could not be made again does not stay behind as if it had been');
  assert.equal(checkWords(s.indexDir, s.manifest).ok, false, 'so status shows it');

  // The data folder is gone altogether (and no newer one took its place): the same answer, not an exception.
  fs.rmSync(s.dataDir, { recursive: true });
  assert.equal(await remakeWords(s.indexDir, s), false);
});

test('the search path takes a ready embedder and a ready index, and returns both lists', async () => {
  const notes = {
    'Meaning.md': rec('Meaning', ['The passage the model likes best.', 'A second passage the model likes.']),
    'Other.md': rec('Other', ['Something else entirely.']),
    'Exact.md': rec('Exact', ['Nothing like the question in meaning.', 'The heliotrope accordion is on the top shelf.']),
  };
  // The made-up vectors put Exact.md last by meaning; a count of 2 leaves it off the list by meaning.
  const far = { 'Meaning.md': [1, 0, 0, 0], 'Other.md': [0.8, 0.6, 0, 0], 'Exact.md': [0, 0, 1, 0] };
  const s = indexOf(notes, (key) => far[/** @type {keyof typeof far} */ (key)]);
  const words = wordsFor(s.indexDir, s, {}).table;
  const all = new Float32Array(s.manifest.sidecar.vectors * DIMS);
  /** @type {string[]} */
  const ids = [];
  for (const [key, e] of Object.entries(s.manifest.notes)) for (let n = 0; n < e.passages; n++) { all.set(far[/** @type {keyof typeof far} */ (key)], (e.vec + n) * DIMS); ids[e.vec + n] = passageId(key, n); }
  const engine = createExact(all, (i) => ids[i], DIMS);
  let embedded = 0;
  const embedder = /** @type {any} */ ({ embedQuery: async () => { embedded++; return Float32Array.from([1, 0, 0, 0]); } });
  const opts = { count: 2, vaultPath: '/nowhere/v', vaultParam: 'v' };

  const r = await searchReady({ embedder, engine, manifest: s.manifest, dataDir: s.dataDir, words }, { ...opts, queries: ['where is the "heliotrope accordion"'] });
  assert.deepEqual(r.results.map((x) => x.vaultPath), ['Meaning.md', 'Other.md'], 'the list by meaning misses it');
  assert.deepEqual(r.exactWords.map((x) => [x.rank, x.passage, x.words]), [[1, 'Exact.md#1', ['heliotrope', 'accordion']]], 'the exact-words list finds it');
  const x = r.exactWords[0];
  assert.equal(x.text, 'The heliotrope accordion is on the top shelf.');
  assert.equal(x.path, path.join('/nowhere/v', 'Exact.md')); assert.equal(x.line, 2); assert.equal(x.note, 'Exact');
  assert.ok(x.score > 0 && x.link && x.snippet && Array.isArray(x.flags));
  assert.deepEqual(Object.keys(r.timings), ['embedMs', 'searchMs', 'wordsMs', 'readMs']);

  const repeat = await searchReady({ embedder, engine, manifest: s.manifest, dataDir: s.dataDir, words }, { ...opts, queries: ['the passage the model likes best'] });
  assert.equal(repeat.results[0].passage, 'Meaning.md#0');
  assert.deepEqual(repeat.exactWords, [], 'it would only repeat a passage already shown, so it is left out');
  assert.deepEqual(repeat.results.map((y) => y.rank), [1, 2], 'and the list by meaning is the same with or without it');

  const several = await searchReady({ embedder, engine, manifest: s.manifest, dataDir: s.dataDir, words }, { ...opts, queries: ['top shelf', 'something else entirely', 'a second passage'] });
  assert.deepEqual(several.exactWords.map((y) => y.passage), ['Exact.md#1', 'Meaning.md#1'], 'each wording contributes; Other.md#0 is already shown');
  const without = await searchReady({ embedder, engine, manifest: s.manifest, dataDir: s.dataDir, words: null }, { ...opts, queries: ['where is the "heliotrope accordion"'] });
  assert.deepEqual(without.exactWords, []);
  assert.deepEqual(without.results, r.results, 'the exact-words list never changes the list by meaning');
  assert.equal(embedded, 1 + 1 + 3 + 1, 'one embedding per wording, nothing else loaded');
});

test('a result path is the name as the disk spells it; the id and the link keep the one spelling', async () => {
  // The key is composed (NFC) with ordinary spaces. On disk the folder and the file hold a decomposed accent and a no-break space.
  const key = 'Résumés/Café\u00a0notes.md'.normalize('NFC').replace(/\u00a0/g, ' ');
  const file = 'Re\u0301sume\u0301s/Cafe\u0301\u00a0notes.md';
  assert.notEqual(key, file);
  const s = indexOf({ [key]: rec('Café notes', ['The heliotrope accordion is on the top shelf.']), 'Plain.md': rec('Plain', ['Something else entirely.']) });
  s.manifest.notes[key].file = file;
  const all = new Float32Array(s.manifest.sidecar.vectors * DIMS);
  /** @type {string[]} */
  const ids = [];
  for (const [k, e] of Object.entries(s.manifest.notes)) { all.set([1, 0, 0, 0], e.vec * DIMS); ids[e.vec] = passageId(k, 0); }
  const embedder = /** @type {any} */ ({ embedQuery: async () => Float32Array.from([1, 0, 0, 0]) });
  const vault = path.join(tmpDir('spelled'), 'v');
  const r = await searchReady({ embedder, engine: createExact(all, (i) => ids[i], DIMS), manifest: s.manifest, dataDir: s.dataDir, words: wordsFor(s.indexDir, s, {}).table }, { count: 1, vaultPath: vault, vaultParam: 'v', queries: ['where is the "heliotrope accordion"'] });
  const byPath = Object.fromEntries([...r.results, ...r.exactWords].map((x) => [x.vaultPath, x]));
  for (const x of [...r.results, ...r.exactWords].filter((y) => y.vaultPath === key)) {
    assert.equal(x.path, path.join(vault, 'Re\u0301sume\u0301s', 'Cafe\u0301\u00a0notes.md'), 'the path an agent opens');
    assert.equal(x.passage, `${key}#0`, 'the id');
    assert.equal(new URL(String(x.link)).searchParams.get('file')?.split('#')[0], key, 'the link');
  }
  assert.ok(byPath[key], 'the respelled note is among the results');
  // A file made from that path opens: the proof on a disk that tells the two forms apart.
  fs.mkdirSync(path.dirname(byPath[key].path), { recursive: true }); fs.writeFileSync(path.join(vault, ...file.split('/')), 'x');
  assert.ok(fs.readdirSync(path.dirname(byPath[key].path)).includes(path.basename(byPath[key].path)), 'the name is one the folder really lists');
  if (byPath['Plain.md']) assert.equal(byPath['Plain.md'].path, path.join(vault, 'Plain.md'), 'a name the key does not respell is built from the key, as before');
});
