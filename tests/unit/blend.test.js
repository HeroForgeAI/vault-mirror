import test from 'node:test';
import assert from 'node:assert/strict';
import { blend, wordsBonus, matchByMeaning, WORDS_FLOOR, WORDS_BONUS, WORDS_STAND_OUT } from '../../src/search/blend.js';

/** @param {string} path @param {number} score @param {number} [n] */
const m = (path, score, n = 0) => ({ path, n, score, morePassages: 0 });
/** @param {string} path @param {number} score @param {number} share @param {number} [n] */
const w = (path, score, share, n = 0) => ({ path, n, score, share, words: ['kestrel'] });

test('the bonus: nothing up to half of the words, then a straight line to the full bonus', () => {
  assert.equal(WORDS_FLOOR, 0.5); assert.equal(WORDS_BONUS, 0.2); assert.equal(WORDS_STAND_OUT, 3);
  for (const share of [0, 0.2, 0.5, NaN]) assert.equal(wordsBonus(share), 0, `a share of ${share} gains nothing`);
  assert.ok(Math.abs(wordsBonus(0.75) - 0.1) < 1e-12);
  assert.equal(wordsBonus(1), 0.2);
  assert.equal(wordsBonus(7), 0.2, 'never more than the full bonus');
  let last = 0;
  for (let share = 0; share <= 1.0001; share += 0.01) { const b = wordsBonus(share); assert.ok(b >= last, 'more of the words never gains less'); last = b; }
});

test('the match by meaning of two vectors: the engine\'s scale, 0 to 1', () => {
  assert.equal(matchByMeaning([1, 0], [2, 0]), 1);
  assert.equal(matchByMeaning([1, 0], [0, 1]), 0);
  assert.equal(matchByMeaning([1, 0], [-1, 0]), 0, 'never below 0');
  assert.equal(matchByMeaning([0, 0], [1, 0]), 0, 'an empty vector matches nothing');
  assert.ok(Math.abs(matchByMeaning([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-12);
});

test('blend: with no exact words the list by meaning comes back as it is', () => {
  const meaning = [m('a.md', 0.9), m('b.md', 0.8), m('c.md', 0.7)];
  assert.deepEqual(blend(meaning, [], 3).map((x) => [x.path, x.score, x.bonus, x.blended]), [['a.md', 0.9, 0, 0.9], ['b.md', 0.8, 0, 0.8], ['c.md', 0.7, 0, 0.7]]);
  assert.deepEqual(blend(meaning, [w('c.md', 0.7, 0.5), w('z.md', 0.1, 0.3)], 3).map((x) => x.path), ['a.md', 'b.md', 'c.md'], 'half of the words or fewer changes nothing');
  assert.deepEqual(blend(meaning, [], 2).map((x) => x.path), ['a.md', 'b.md']);
});

test('blend: a passage with the words moves up by its bonus, from inside the list or from outside it', () => {
  const meaning = [m('a.md', 0.9), m('b.md', 0.8), m('c.md', 0.7)];
  const inside = blend(meaning, [w('c.md', 0.7, 1)], 3);
  assert.deepEqual(inside.map((x) => x.path), ['a.md', 'c.md', 'b.md']);
  assert.ok(Math.abs(inside[1].blended - 0.9) < 1e-12 && inside[1].score === 0.7 && inside[1].bonus === 0.2);
  const outside = blend(meaning, [w('new.md', 0.65, 1, 4)], 3);
  assert.deepEqual(outside.map((x) => [x.path, x.n]), [['a.md', 0], ['new.md', 4], ['b.md', 0]], 'the last by meaning makes room');
  assert.deepEqual(outside[1].words, ['kestrel']);
});

test('blend: a note is listed once, by its best passage', () => {
  const meaning = [m('a.md', 0.9, 0), m('b.md', 0.8, 0)];
  // b.md's passage 3 holds the words but is far by meaning; its passage 0 still ranks higher without them.
  assert.deepEqual(blend(meaning, [w('b.md', 0.3, 1, 3)], 5).map((x) => [x.path, x.n, x.bonus]), [['a.md', 0, 0], ['b.md', 0, 0]]);
  // Here the passage with the words wins, and it is the one shown.
  assert.deepEqual(blend(meaning, [w('b.md', 0.75, 1, 3)], 5).map((x) => [x.path, x.n, x.bonus]), [['b.md', 3, 0.2], ['a.md', 0, 0]]);
  // The same passage as the best by meaning keeps the list's own match number.
  assert.deepEqual(blend(meaning, [w('b.md', 0.7999999, 1, 0)], 5).map((x) => [x.path, x.score]), [['b.md', 0.8], ['a.md', 0.9]]);
  // Two wordings name two passages of one note: the higher one stands.
  assert.deepEqual(blend(meaning, [w('b.md', 0.5, 1, 1), w('b.md', 0.75, 1, 2)], 5).map((x) => [x.path, x.n]), [['b.md', 2], ['a.md', 0]]);
});

test('blend: words that many notes hold equally gain each of them less', () => {
  const meaning = [m('top.md', 0.85)];
  const three = ['a.md', 'b.md', 'c.md'].map((p, i) => w(p, 0.7 - i * 0.01, 1));
  assert.deepEqual(blend(meaning, three, 4).map((x) => x.path), ['a.md', 'b.md', 'c.md', 'top.md'], 'three notes stand out: each gains the full bonus');
  const twelve = Array.from({ length: 12 }, (_, i) => w(`n${String(i).padStart(2, '0')}.md`, 0.7 - i * 0.01, 1));
  const crowded = blend(meaning, twelve, 4);
  assert.equal(crowded[0].path, 'top.md', 'twelve notes hold the words equally: the best by meaning stays first');
  assert.ok(Math.abs(crowded[1].bonus - 0.2 * 3 / 12) < 1e-12);
  // One note holds all of the words and eleven hold most of them: the one stands out.
  const one = blend(meaning, [...twelve.slice(1).map((x) => ({ ...x, share: 0.8 })), w('all.md', 0.7, 1)], 4);
  assert.deepEqual([one[0].path, one[0].bonus], ['all.md', 0.2]);
});

test('blend: the order is fixed; equal scores go by match, then by path, whatever order they arrive in', () => {
  const meaning = [m('b.md', 0.8), m('a.md', 0.8), m('d.md', 0.6)];
  const words = [w('z.md', 0.6, 1), w('y.md', 0.6, 1), w('d.md', 0.6, 1)];
  const want = ['a.md', 'b.md', 'd.md', 'y.md', 'z.md'];
  assert.deepEqual(blend(meaning, words, 5).map((x) => x.path), want);
  assert.deepEqual(blend([...meaning].reverse(), [...words].reverse(), 5).map((x) => x.path), want);
  assert.deepEqual(blend(meaning, [words[1], words[2], words[0]], 5).map((x) => x.path), want);
  // The same blended number from a higher match and no bonus goes first.
  assert.deepEqual(blend([m('plain.md', 0.8)], [w('words.md', 0.6, 1)], 2).map((x) => x.path), ['plain.md', 'words.md']);
});

test('blend: a note never falls by more places than there are notes with a bonus', () => {
  const meaning = Array.from({ length: 8 }, (_, i) => m(`m${i}.md`, 0.9 - i * 0.05));
  const words = [w('x.md', 0.5, 1), w('y.md', 0.5, 0.9), w('m7.md', 0.55, 0.8)];
  const out = blend(meaning, words, 8).map((x) => x.path);
  meaning.forEach((note, i) => { const at = out.indexOf(note.path); if (at >= 0) assert.ok(at - i <= 3, `${note.path} fell from ${i} to ${at}`); });
  assert.equal(out.length, 8);
});
