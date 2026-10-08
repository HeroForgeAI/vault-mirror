import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chunk, buildPrefix, PREFIX_CAP_TOKENS } from '../../src/chunker/index.js';
import { readFrontmatter } from '../../src/chunker/frontmatter.js';
import { cleanLine, cleanInline } from '../../src/chunker/clean.js';
import { splitUnit } from '../../src/chunker/pack.js';
import { SETTINGS, fakeCount } from '../helpers/tmp.mjs';

const enc = (/** @type {string} */ s) => new TextEncoder().encode(s);
const run = (/** @type {string} */ text, path = 'Folder/Note.md', extra = {}) => chunk(enc(text), path, { ...SETTINGS, ...extra });
const fixture = (/** @type {string} */ rel) => fs.readFileSync(new URL(`../fixtures/vault/${rel}`, import.meta.url));
const bodies = (/** @type {ReturnType<typeof run>} */ r) => r.passages.map((p) => p.text).join('\n');
const words = (/** @type {number} */ n, w = 'lantern') => Array.from({ length: n }, (_, i) => `${w}${i % 9}`).join(' ');
const withinBudget = (/** @type {ReturnType<typeof run>} */ r) => r.passages.every((p) => fakeCount(p.embedText) <= SETTINGS.budgetTokens);

test('purity: the same bytes, path and settings give the same passages', () => {
  const bytes = fixture('Garden/Garden plan.md');
  assert.deepEqual(chunk(bytes, 'Garden/Garden plan.md', SETTINGS), chunk(bytes, 'Garden/Garden plan.md', SETTINGS));
});

test('sections, trail, prefix and line numbers', () => {
  const r = chunk(fixture('Garden/Garden plan.md'), 'Garden/Garden plan.md', SETTINGS);
  assert.equal(r.title, 'Garden plan');
  assert.deepEqual(r.aliases, ['Plot plan', 'Allotment calendar']);
  const plant = r.passages.find((p) => p.text.includes('Start the tomatoes'));
  assert.ok(plant);
  assert.deepEqual(plant.trail, ['Spring', 'When to plant'], 'the title heading is dropped from the trail');
  assert.equal(plant.embedText.split('\n')[0], 'Garden plan > Spring > When to plant');
  const lines = fixture('Garden/Garden plan.md').toString().split('\n');
  for (const p of r.passages) assert.ok(lines[p.line - 1].length > 0, 'a passage starts on a real line of the file');
  assert.ok(lines[plant.line - 1].startsWith('Start the tomatoes'));
  assert.deepEqual(r.passages.map((p) => p.n), r.passages.map((_, i) => i), 'numbered from 0 with no gaps');
  assert.ok(r.passages.every((p) => p.text.trim().length > 0), 'no empty passage');
  assert.ok(r.passages[0].embedText.startsWith('Garden plan (also: Plot plan, Allotment calendar)'), 'the first passage carries the aliases');
  assert.ok(!r.passages[1].embedText.includes('also:'));
  assert.ok(!bodies(r).includes('aliases'), 'frontmatter never reaches a passage');
});

test('case 1: a pipe in a file name, linked as [[A | B]]', () => {
  assert.equal(cleanInline('see [[A | B]] now'), 'see A B now');
});

test('case 3 and 25: a closing fence with text after it; a heading below a fence that never closes', () => {
  const r = chunk(fixture('Edge/Unclosed fence.md'), 'Edge/Unclosed fence.md', SETTINGS);
  const below = r.passages.find((p) => p.text.includes('otter'));
  assert.ok(below, 'the heading below the fence is found');
  assert.deepEqual(below.trail, ['Heading below the fence']);
  assert.equal(below.recovered, true);
  assert.equal(r.passages.find((p) => p.text.includes('Some text before')).recovered, false);
  const none = run('# T\n\nintro words here\n\n```js\nconst a = 1;\n\n## Still found\n\nwords under the heading here\n');
  assert.ok(none.passages.some((p) => p.trail.includes('Still found')), 'with no close at all the opening line is plain text');
});

test('case 4: one line of 1,000 words is split at sentences then words, every piece within budget', () => {
  const sentences = Array.from({ length: 50 }, (_, i) => `${words(19)} end${i}.`).join(' ');
  const r = run(`# Long\n\n${sentences}\n`);
  assert.ok(r.passages.length > 8);
  assert.ok(withinBudget(r));
  assert.ok(r.passages.every((p) => p.line === 3));
  assert.ok(r.passages.slice(0, -1).every((p) => /[.]$/.test(p.text)), 'pieces end at sentence ends');
  assert.equal(r.passages.map((p) => p.text).join(' '), sentences, 'no word is lost or cut');
});

test('case 5: a table of 3,000 words keeps rows whole', () => {
  const rows = Array.from({ length: 300 }, (_, i) => `| row${i} | ${words(4)} | ${words(4, 'gate')} | done |`);
  const r = run(`# Table\n\n| a | b | c | d |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n`);
  assert.ok(withinBudget(r));
  const all = r.passages.flatMap((p) => p.text.split('\n'));
  assert.equal(all.filter((l) => /^row\d+; /.test(l)).length, 300, 'every row is whole, cells joined with "; "');
  assert.ok(!bodies(r).includes('---'));
});

test('case 6 and 15: # lines inside fences are not headings; longer and tilde fences are tracked', () => {
  const a = chunk(fixture('Edge/Hash comments in code.md'), 'Edge/Hash comments in code.md', SETTINGS);
  assert.deepEqual([...new Set(a.passages.flatMap((p) => p.trail))], ['Real heading']);
  assert.ok(bodies(a).includes('# this is a shell comment'));
  const b = chunk(fixture('Edge/Nested fences.md'), 'Edge/Nested fences.md', SETTINGS);
  assert.deepEqual([...new Set(b.passages.flatMap((p) => p.trail))], ['After the fences']);
  assert.ok(bodies(b).includes('```js'), 'a shorter fence inside a longer one is content');
  assert.ok(bodies(b).includes('A tilde fence.'));
});

test('case 7: a 4,000-word section with no inner headings gives dozens of passages with one prefix', () => {
  const paras = Array.from({ length: 200 }, () => `${words(20)}.`).join('\n\n');
  const r = run(`# Big\n\n## Only section\n\n${paras}\n`, 'Big.md');
  assert.ok(r.passages.length >= 24);
  assert.equal(new Set(r.passages.map((p) => p.embedText.split('\n')[0])).size, 1);
  assert.ok(withinBudget(r));
  assert.deepEqual(run(`# Big\n\n## Only section\n\n${paras}\n`, 'Big.md').passages.map((p) => p.n), r.passages.map((p) => p.n), 'ids are stable');
});

test('case 8: a repeated file name puts the folder in the prefix, and the flag flips cleanly', () => {
  const text = '# About\n\nNotes about this one folder and nothing else.\n';
  const withFolder = run(text, 'Readmes/Folder 7/README.md', { folderInPrefix: true });
  assert.ok(withFolder.passages[0].embedText.startsWith('Folder 7 > README > About'));
  const alone = run(text, 'Readmes/Folder 7/README.md', { folderInPrefix: false });
  assert.ok(alone.passages[0].embedText.startsWith('README > About'));
});

test('case 10: frontmatter forms never crash, and a note that opens with a rule keeps all its text', () => {
  assert.ok(bodies(chunk(fixture('Edge/No frontmatter.md'), 'Edge/No frontmatter.md', SETTINGS)).includes('no properties block'));
  const lists = chunk(fixture('Edge/Frontmatter block lists.md'), 'Edge/Frontmatter block lists.md', SETTINGS);
  assert.deepEqual(lists.aliases, ['Linked alias', 'Plain alias']);
  assert.deepEqual(lists.tags, ['edge', 'lists']);
  assert.ok(!bodies(lists).includes('related'));
  const unclosed = chunk(fixture('Edge/Unclosed frontmatter.md'), 'Edge/Unclosed frontmatter.md', SETTINGS);
  assert.ok(bodies(unclosed).includes('this block never closes'), 'no closing line means no frontmatter');
  const rule = chunk(fixture('Journal/A day that opens with a rule.md'), 'Journal/A day that opens with a rule.md', SETTINGS);
  assert.ok(bodies(rule).includes('Rain all morning'));
  assert.ok(bodies(rule).includes('first swallows'));
});

test('case 11, 12, 14, 19: empty sections, mermaid, no headings, empty notes', () => {
  const hh = chunk(fixture('Edge/Heading then heading.md'), 'Edge/Heading then heading.md', SETTINGS);
  assert.ok(hh.passages.every((p) => !p.trail.includes('Empty section')));
  assert.equal(chunk(fixture('Edge/Mermaid only.md'), 'Edge/Mermaid only.md', SETTINGS).passages.length, 0, 'a note that is only a mermaid block is empty');
  const mt = chunk(fixture('Edge/Mermaid and text.md'), 'Edge/Mermaid and text.md', SETTINGS);
  assert.ok(bodies(mt).includes('ferry timetable') && !bodies(mt).includes('Dock'));
  const nh = chunk(fixture('Edge/No frontmatter.md'), 'Edge/No frontmatter.md', SETTINGS);
  assert.equal(nh.passages.length, 1);
  assert.deepEqual(nh.passages[0].trail, []);
  for (const f of ['Edge/Empty.md', 'Edge/Only frontmatter.md', 'Edge/Two words.md']) {
    const r = chunk(fixture(f), f, SETTINGS);
    assert.equal(r.indexable, true);
    assert.equal(r.passages.length, 0, `${f} has no passage`);
  }
});

test('case 13: a 100-character title is capped and the body still gets at least 80 tokens', () => {
  const name = 'Edge/This title is deliberately very long so that the prefix cap has real work to do in tests.md';
  const r = chunk(fixture(name), name, SETTINGS);
  for (const p of r.passages) {
    const prefix = p.embedText.split('\n')[0];
    assert.ok(fakeCount(prefix) <= PREFIX_CAP_TOKENS, `prefix within the cap: ${prefix}`);
    assert.ok(SETTINGS.budgetTokens - fakeCount(prefix) >= 80);
  }
  const long = buildPrefix({ folder: 'Folder', title: words(30), alias: '', trail: ['One', 'Two', words(20, 'deep')] }, fakeCount);
  assert.ok(fakeCount(long) <= PREFIX_CAP_TOKENS);
  assert.ok(!long.startsWith('Folder'), 'the folder is dropped before the title is cut');
});

test('case 16: links and embeds are flattened per the cleaning table', () => {
  assert.equal(cleanInline('[[Note]] [[Folder/Note]]'), 'Note Note');
  assert.equal(cleanInline('[[Note|shown]]'), 'shown');
  assert.equal(cleanInline('[[Note\\|shown]]'), 'shown');
  assert.equal(cleanInline('[[Note#Heading]]'), 'Note > Heading');
  assert.equal(cleanInline('[[#Same note heading]]'), 'Same note heading');
  assert.equal(cleanInline('[[A#^block]]'), 'A');
  assert.equal(cleanInline('[[A#H|b]]'), 'b');
  assert.equal(cleanInline('x ![[image.png]] y'), 'x  y');
  assert.equal(cleanInline('![[Note]] ![[Note#Heading]]'), 'Note Note');
  assert.equal(cleanInline('[text](https://example.org/a?b=1) ![alt](pic.png)'), 'text alt');
  assert.equal(cleanInline('see https://example.com/path/to/page now'), 'see example.com now');
  assert.equal(cleanInline('a **bold** ==mark== ~~gone~~ `code` b[^1]'), 'a bold mark gone code b');
  assert.equal(cleanInline('<span class="x">kept</span>'), 'kept');
  assert.equal(cleanLine('> [!note] Title'), 'Title');
  assert.equal(cleanLine('> quoted words'), 'quoted words');
  assert.equal(cleanLine('- [ ] buy nails'), '- buy nails');
  assert.equal(cleanLine('- [x] buy felt'), '- buy felt');
  assert.equal(cleanLine('A paragraph with an id ^abc123'), 'A paragraph with an id');
  assert.equal(cleanLine('| --- | :---: |'), null);
  assert.equal(cleanLine('| a | b | c |'), 'a; b; c');
  assert.equal(cleanLine('single *star* and snake_case stay'), 'single *star* and snake_case stay');
  const r = chunk(fixture('Edge/Links.md'), 'Edge/Links.md', SETTINGS);
  assert.ok(bodies(r).includes('the heap; escaped pipe in a table'));
  assert.ok(bodies(r).includes('Left Right'));
  assert.ok(!bodies(r).includes('pixel.png') && !bodies(r).includes('[['));
});

test('case 17: CRLF, a byte-order mark, and line numbers that still refer to the file', () => {
  const r = chunk(fixture('Edge/CRLF and BOM.md'), 'Edge/CRLF and BOM.md', SETTINGS);
  assert.equal(r.passages.length, 2);
  assert.ok(!r.passages[0].text.includes('\r') && !r.passages[0].text.includes('﻿'));
  assert.equal(r.passages[0].line, 3);
  assert.equal(r.passages[1].line, 7);
  assert.deepEqual(r.passages[1].trail, ['Second part']);
  const emoji = run('# Sprout\n\nThe seedlings came up today \u{1F331} at last.\n', 'Café \u{1F331}.md');
  assert.equal(emoji.title, 'Café \u{1F331}');
  const bad = chunk(new Uint8Array([35, 32, 84, 10, 10, 0xff, 0xfe, 32, 119, 111, 114, 100, 115, 32, 104, 101, 114, 101, 32, 110, 111, 119]), 'Bad.md', SETTINGS);
  assert.equal(bad.passages.length, 1, 'invalid UTF-8 is replaced, not fatal');
});

test('Windows line endings: the same passages, headings and line numbers as plain ones', () => {
  const lf = ['---', 'tags: [work]', '---', '# Harbour log', '', 'The ferry rope was spliced on Tuesday and the bollard was painted.', '', '## Tides', '', 'High water came at six, and the mill pond filled by seven.', '', '- a list item about the seed tray', '- another about the rain gauge', '', '### Springs', '', words(260), '', '```js', 'const x = 1;', '```', '', '## Last part', '', 'The wood stove gets cleaned before the first frost.', ''].join('\n');
  const a = run(lf); const b = run(lf.replace(/\n/g, '\r\n'));
  assert.ok(a.passages.length >= 4);
  assert.deepEqual(b.passages.map((p) => [p.n, p.line, p.trail, p.heads, p.text, p.embedText]), a.passages.map((p) => [p.n, p.line, p.trail, p.heads, p.text, p.embedText]));
  assert.deepEqual([b.title, b.indexable], [a.title, a.indexable]);
  assert.ok(!JSON.stringify(b.passages).includes('\\r'));
  // A file that mixes the two, and one with no line ending at its end.
  const mixed = run(lf.replace('\n## Tides\n', '\r\n## Tides\r\n').replace(/\n$/, ''));
  assert.deepEqual(mixed.passages.map((p) => [p.line, p.trail, p.text]), a.passages.map((p) => [p.line, p.trail, p.text]));
});

test('case 18 and 24: the index rule fails closed, and ... does not end a properties block', () => {
  for (const f of ['Index false', 'Index False capital', 'Index key capital', 'Index quoted', 'Index no', 'Dots then index false']) {
    const r = chunk(fixture(`Edge/${f}.md`), `Edge/${f}.md`, SETTINGS);
    assert.equal(r.indexable, false, f);
    assert.equal(r.passages.length, 0, f);
  }
  for (const f of ['Index empty', 'Index true', 'Dots keep']) {
    const r = chunk(fixture(`Edge/${f}.md`), `Edge/${f}.md`, SETTINGS);
    assert.equal(r.indexable, true, f);
    assert.ok(r.passages.length > 0, f);
    assert.ok(!bodies(r).includes('title: dots') && !bodies(r).includes('index:'), `${f}: none of the block reaches a passage`);
  }
  assert.deepEqual(chunk(fixture('Edge/Dots keep.md'), 'Edge/Dots keep.md', SETTINGS).aliases, ['Ellipsis note']);
  assert.equal(readFrontmatter(['---', 'this is prose, not yaml at all!', 'index: off', '---', 'body']).indexOff, true, 'not YAML-like, still left out');
  assert.equal(readFrontmatter(['---', 'index: 0', '---']).indexOff, true);
  assert.equal(readFrontmatter(['---', '  index: false', '---']).indexOff, false, 'only a top-level key counts');
  assert.equal(readFrontmatter(['---', 'index: falsey', '---']).indexOff, false);
});

test('case 21: tickers, hex, prices and non-Latin text all stay within budget', () => {
  for (const f of ['Edge/Tickers and hex.md', 'Edge/Non-Latin.md', 'Projects/Budget.md']) assert.ok(withinBudget(chunk(fixture(f), f, SETTINGS)), f);
  const dense = run(`# Dense\n\n${Array.from({ length: 400 }, (_, i) => `QX${i}/USD@${i}.${i}5`).join(' ')}\n`);
  assert.ok(withinBudget(dense));
  const oneWord = run(`# Word\n\nstart ${'a/b.c-d_e+f=g'.repeat(200)} end words\n`);
  assert.ok(withinBudget(oneWord), 'one unbroken word larger than a piece is cut at punctuation');
  assert.ok(splitUnit('x'.repeat(5000), 20, (t) => t.length).every((p) => p.length <= 20));
});

test('case 22 and 23: a stray %% removes nothing, %% in a fence is untouched, prices survive', () => {
  const r = chunk(fixture('Edge/Comments.md'), 'Edge/Comments.md', SETTINGS);
  const text = bodies(r);
  assert.ok(text.includes('Visible before.') && text.includes('Visible after.'));
  assert.ok(!text.includes('hidden inline comment') && !text.includes('hidden block comment'));
  assert.ok(text.includes('A stray %% in the middle of a sentence removes nothing after it.'));
  assert.ok(text.includes('The windmill keeps turning.'));
  assert.ok(text.includes('%% inside a fence stays exactly as written %%'));
  const prices = chunk(fixture('Projects/Budget.md'), 'Projects/Budget.md', SETTINGS);
  assert.ok(bodies(prices).includes('from $4.75 to $5 a metre'));
  assert.equal(bodies(run('# T\n\nbefore <!-- gone --> kept words\n', 'T.md')), 'before kept words');
});

test('minWords drops a short section, and dropFences drops only the named languages', () => {
  const r = run('# T\n\n## Short\n\ntwo words\n\n## Long enough\n\nthree words here\n\n```dataview\nTABLE x\n```\n\n```js\nlet kept = 1;\n```\n', 'T.md');
  assert.deepEqual(r.passages.map((p) => p.trail[0]), ['Long enough']);
  assert.ok(bodies(r).includes('let kept = 1;') && !bodies(r).includes('TABLE x'));
});

test('a tiny last piece is shared with the one before it', () => {
  const r = run(`# T\n\n${Array.from({ length: 12 }, () => `${words(12)}.`).join('\n')}\n`);
  assert.ok(r.passages.length >= 2);
  const sizes = r.passages.map((p) => fakeCount(p.text));
  assert.ok(sizes[sizes.length - 1] >= 30, `last piece is not tiny: ${sizes}`);
});
