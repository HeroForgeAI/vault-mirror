// @ts-check
// The exact-words list: passages that hold the question's distinctive words, ranked with BM25 over
// the tool's own passage store. No model is involved. The BM25 score orders this list only: what a
// blended search adds to a match by meaning is the passage's share of the question's words (blend.js).
import { readQuestion, tokenise, hashToken, hasPhrase, passageFields } from '../words/tokens.js';
import { findWords, rankPassages, idf } from '../words/bm25.js';

export const EXACT_WORDS_PER_WORDING = 3;
export const EXACT_WORDS_SHOWN = 3;
const MAX_WORDS = 255;   // distinct words across all wordings of one call
const MAX_CHECKED = 300; // passages read back per wording before giving up on a phrase

/**
 * @typedef {{ note: number, n: number, score: number, share: number, words: string[], wording: number, place: number }} ExactHit
 *   note = position of the note in the table; n = passage number in the note; place = rank within its wording, from 0;
 *   share = how much of its wording's distinctive words the passage holds, rare words counting for more, 0..1.
 *   It counts which words are there, not how often: a passage that repeats one of two words holds half at most
 */

/**
 * Every wording's own ranking, one passage per note, before the wordings are merged.
 * @param {import('../words/table.js').WordsTable} table
 * @param {(note: number) => { title?: string, passages: { trail?: string[], text: string }[] }} readNote   the saved record of a note
 * @param {string[]} queries   one or several wordings; each contributes
 * @param {{ perWording?: number }} [o]
 * @returns {ExactHit[]}   wording by wording, each best first
 */
export function exactWordCandidates(table, readNote, queries, o = {}) {
  const perWording = o.perWording ?? EXACT_WORDS_PER_WORDING;
  const wordings = queries.map(readQuestion);
  /** @type {Map<string, number>} */
  const at = new Map();
  for (const w of wordings) for (const word of w.words) if (!at.has(word) && at.size < MAX_WORDS) at.set(word, at.size);
  if (!at.size || !table.passages) return [];
  const found = findWords(table, [...at.keys()].map(hashToken));

  const first = new Uint32Array(table.notes + 1);
  for (let i = 0; i < table.notes; i++) first[i + 1] = first[i] + table.notePassages[i];
  const noteOf = (/** @type {number} */ p) => { let lo = 0; let hi = table.notes - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (first[mid] <= p) lo = mid; else hi = mid - 1; } return lo; };
  /** @type {Map<number, ReturnType<typeof readNote>>} */
  const records = new Map();
  const record = (/** @type {number} */ note) => { let r = records.get(note); if (!r) { r = readNote(note); records.set(note, r); } return r; };
  const index = (/** @type {string[]} */ words) => /** @type {number[]} */ (words.map((w) => at.get(w)).filter((i) => i !== undefined));

  /** @type {ExactHit[]} */
  const all = [];
  wordings.forEach((w, wording) => {
    const mine = index(w.words);
    if (!mine.length) return;
    // A quoted phrase must be there in full: only passages that hold every word of every phrase are ranked.
    const required = index([...new Set(w.phrases.flat())]);
    const ranked = rankPassages(table, found, mine, required);
    // A word's weight is how rare it is in this vault; the wording's words together are the whole.
    const weight = new Map(w.words.map((word) => { const i = at.get(word); return [word, i === undefined ? 0 : idf(table.passages, found.df[i])]; }));
    let whole = 0;
    for (const x of weight.values()) whole += x;
    const taken = new Set(); let checked = 0;
    for (const cand of ranked) {
      if (taken.size >= perWording || checked >= MAX_CHECKED) break;
      const note = noteOf(cand.passage);
      if (taken.has(note)) continue;
      const n = cand.passage - first[note];
      const rec = record(note);
      const passage = rec.passages[n];
      if (!passage) continue;
      checked++;
      // Read the passage itself: the table holds numbers, and the words it reports must really be there.
      const fields = passageFields(rec, passage).map(tokenise);
      const present = new Set(fields.flat());
      const words = w.words.filter((word) => present.has(word));
      if (!words.length) continue;
      if (!w.phrases.every((phrase) => fields.some((tokens) => hasPhrase(tokens, phrase)))) continue;
      let held = 0;
      for (const word of words) held += weight.get(word) || 0;
      all.push({ note, n, score: cand.score, share: whole > 0 ? Math.min(1, held / whole) : 0, words, wording, place: taken.size });
      taken.add(note);
    }
  });
  return all;
}

/**
 * Merge the wordings: every wording's best first, then every wording's second, and so on; a note is listed once.
 * @template {{ note: unknown, score: number, wording: number, place: number }} T
 * @param {T[]} candidates @param {number} [perWording]   how many of each wording's passages take part
 * @returns {T[]}
 */
export function mergeWordings(candidates, perWording = EXACT_WORDS_PER_WORDING) {
  const all = candidates.filter((h) => h.place < perWording);
  all.sort((a, b) => a.place - b.place || b.score - a.score || a.wording - b.wording);
  const seen = new Set();
  return all.filter((h) => (seen.has(h.note) ? false : (seen.add(h.note), true)));
}

/**
 * The exact-words list of one call.
 * @param {Parameters<typeof exactWordCandidates>[0]} table @param {Parameters<typeof exactWordCandidates>[1]} readNote
 * @param {string[]} queries @param {{ perWording?: number }} [o]
 * @returns {ExactHit[]}   one passage per note, each wording's best first
 */
export function exactWordHits(table, readNote, queries, o = {}) {
  const perWording = o.perWording ?? EXACT_WORDS_PER_WORDING;
  return mergeWordings(exactWordCandidates(table, readNote, queries, { perWording }), perWording);
}

/**
 * Leave out what the list by meaning already shows, and keep a short list.
 * @template {{ passage: string }} T
 * @param {T[]} hits @param {{ passage: string }[]} shown @param {number} [max]
 * @returns {T[]}
 */
export function notAlreadyShown(hits, shown, max = EXACT_WORDS_SHOWN) {
  const have = new Set(shown.map((r) => r.passage));
  return hits.filter((h) => !have.has(h.passage)).slice(0, max);
}
