// Temp folders for tests. Set VAULT_MIRROR_TEST_TMP to keep them somewhere specific.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const made = [];
/** @param {string} [label] */
export function tmpDir(label = 'vm') {
  const base = process.env.VAULT_MIRROR_TEST_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  // The native call gives the one true path, as the tool does: on Windows it also expands a short name such as RUNNER~1.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(base, `${label}-`)));
  made.push(dir);
  return dir;
}
/** The link type for a folder: a junction on Windows, which needs no special rights. */
export const DIR_LINK = process.platform === 'win32' ? 'junction' : 'dir';

process.on('exit', () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* leave it */ } } });

/** A stand-in token counter for tests that need no model: one token per word or punctuation mark, more for long words. @param {string} text */
export function fakeCount(text) {
  let n = 0;
  for (const w of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    for (const part of w.split(/(?<=[\p{P}\p{S}])|(?=[\p{P}\p{S}])/u).filter(Boolean)) n += /[\p{P}\p{S}]/u.test(part) ? 1 : Math.max(1, Math.ceil(part.length / 6));
  }
  return n;
}

export const SETTINGS = { countTokens: fakeCount, budgetTokens: 110, minWords: 3, dropFences: ['mermaid', 'dataview', 'dataviewjs', 'query', 'base', 'tasks'], folderInPrefix: false };

/** A tiny invented WordPiece tokenizer file, in the shape the real one has. */
export function tinyTokenizer() {
  const words = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'the', 'garden', 'is', 'behind', 'house', 'water', '##ing', '##s', 'cafe', 'price', 'eth', 'usd', '##t', '4', '75', '.', '/', '|', ',', '$', 'a', 'b', 'c', '##b', '##c', '9', 'f', '##8', '##6', '園', '庭'];
  return { normalizer: { type: 'BertNormalizer', clean_text: true, handle_chinese_chars: true, strip_accents: null, lowercase: true }, model: { type: 'WordPiece', unk_token: '[UNK]', continuing_subword_prefix: '##', max_input_chars_per_word: 100, vocab: Object.fromEntries(words.map((w, i) => [w, i])) } };
}
