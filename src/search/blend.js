// @ts-check
// The blend: one ranked list from the match by meaning and the question's exact words.
// A passage keeps its match by meaning and gains a bonus when it holds at least half of the question's
// distinctive words (rare words counting for more). Below half, nothing is added: a passage that shares
// one common word with the question does not move. No model is involved and nothing is read from disk here.

/** A passage that holds less than this share of the question's words gains nothing. */
export const WORDS_FLOOR = 0.5;
/** What a passage that holds all of the question's words gains, on the 0..1 scale of the match by meaning. */
export const WORDS_BONUS = 0.2;
/** The full bonus goes to at most this many notes; when more hold the words as fully, each gains less. */
export const WORDS_STAND_OUT = 3;
/** How many of each wording's exact-words passages are looked at for a bonus. */
export const BLEND_PER_WORDING = 20;

/**
 * The bonus for a share of the question's words: 0 up to the floor, then a straight line to the full bonus.
 * @param {number} share   0..1
 */
export function wordsBonus(share) {
  if (!(share > WORDS_FLOOR)) return 0;
  return WORDS_BONUS * (Math.min(1, share) - WORDS_FLOOR) / (1 - WORDS_FLOOR);
}

/**
 * @typedef {{ path: string, n: number, score: number, morePassages: number }} MeaningNote   a note's best passage by meaning
 * @typedef {{ path: string, n: number, score: number, share: number, words: string[] }} WordsPassage
 *   a passage that holds the question's words; score = its own match by meaning
 * @typedef {{ path: string, n: number, score: number, bonus: number, blended: number, words: string[], morePassages: number }} Blended
 */

/**
 * One list, best first. A note is listed once, by the passage that ranks highest.
 * The order is fixed for equal input: blended score, then match by meaning, then path.
 * @param {MeaningNote[]} meaning   best first
 * @param {WordsPassage[]} words    any order; passages without a bonus are ignored
 * @param {number} count
 * @returns {Blended[]}
 */
export function blend(meaning, words, count) {
  /** @type {Map<string, Blended>} */
  const byNote = new Map();
  /** @type {Map<string, MeaningNote>} */
  const byMeaning = new Map();
  for (const m of meaning) { byMeaning.set(m.path, m); byNote.set(m.path, { path: m.path, n: m.n, score: m.score, bonus: 0, blended: m.score, words: [], morePassages: m.morePassages }); }
  // How many notes hold the words at least as fully as this one: words that many notes hold tell little apart.
  /** @type {Map<string, number>} */
  const best = new Map();
  for (const w of words) if (wordsBonus(w.share) > 0 && w.share > (best.get(w.path) || 0)) best.set(w.path, w.share);
  const shares = [...best.values()];
  const crowd = (/** @type {number} */ share) => { let n = 0; for (const x of shares) if (x >= share) n++; return n; };
  for (const w of words) {
    const bonus = wordsBonus(w.share) * Math.min(1, WORDS_STAND_OUT / (crowd(w.share) || 1));
    if (bonus <= 0) continue;
    const m = byMeaning.get(w.path);
    // The same passage as the note's best by meaning keeps that list's own number for its match.
    const score = m && m.n === w.n ? m.score : w.score;
    const blended = score + bonus;
    const cur = byNote.get(w.path);
    if (cur && (cur.blended > blended || (cur.blended === blended && (cur.score > score || (cur.score === score && cur.n <= w.n))))) continue;
    byNote.set(w.path, { path: w.path, n: w.n, score, bonus, blended, words: w.words, morePassages: m ? m.morePassages : 0 });
  }
  return [...byNote.values()]
    .sort((a, b) => b.blended - a.blended || b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, count);
}

/**
 * Cosine similarity on the engine's own scale: 1 - distance, kept within 0..1.
 * @param {ArrayLike<number>} a @param {ArrayLike<number>} b
 */
export function matchByMeaning(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const s = dot / ((Math.sqrt(na) || 1) * (Math.sqrt(nb) || 1));
  return s < 0 ? 0 : s > 1 ? 1 : s;
}
