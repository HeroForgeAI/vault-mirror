// @ts-check
// How much text a search handed back, beside the size of the notes it came from. Two counts of words,
// taken from records the search has already read. No multiplier and no figure for a saving is worked out.
import { num, plural } from '../cli/output.js';

/** Words in a text: runs of characters between spaces. @param {string} text */
export function countWords(text) { return text.split(/\s+/).filter(Boolean).length; }

/**
 * @typedef {{ passages: number, words: number, notes: number, noteWords: number }} Reading
 * `words` is the text of the passages returned. `noteWords` is the indexed text of the notes they came
 * from: every saved passage of each note, counted once per note.
 */

/**
 * @param {{ vaultPath: string, text: string }[]} shown                 every passage in both lists
 * @param {(notePath: string) => { passages: { text: string }[] }} record  a note's saved record
 * @returns {Reading}
 */
export function measureReading(shown, record) {
  const notes = new Set(shown.map((x) => x.vaultPath));
  let words = 0; let noteWords = 0;
  for (const x of shown) words += countWords(x.text);
  for (const key of notes) for (const p of record(key).passages) noteWords += countWords(p.text);
  return { passages: shown.length, words, notes: notes.size, noteWords };
}

/** 587 -> "590"; 9214 -> "9,200"; under 100 as it is. @param {number} n */
function rounded(n) {
  if (n < 100) return num(n);
  const step = 10 ** (Math.floor(Math.log10(n)) - 1);
  return num(Math.round(n / step) * step);
}

/** The one line a search ends with. @param {Reading} r */
export function readingLine(r) {
  return `Returned about ${rounded(r.words)} ${r.words === 1 ? 'word' : 'words'} in ${plural(r.passages, 'passage')}, from ${plural(r.notes, 'note')} that ${r.notes === 1 ? 'holds' : 'hold'} about ${rounded(r.noteWords)} ${r.noteWords === 1 ? 'word' : 'words'}.`;
}
