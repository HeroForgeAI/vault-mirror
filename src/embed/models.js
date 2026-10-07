// @ts-check
// The model table: the one place a reading model plugs in.
// Nothing outside src/embed/ knows a model name, a vector size or a token window.

/**
 * @typedef {object} ModelEntry
 * @property {string} name
 * @property {number} dimensions      vector size
 * @property {number} windowTokens    content tokens the model really reads
 * @property {number} budgetTokens    what the chunker may use per passage, prefix included
 * @property {number} maxLength       padding length passed to the library (same vectors, less work)
 * @property {'wordpiece'} counter    the token counter this model needs
 * @property {string} queryLead       text placed in front of a question
 * @property {string} passageLead     text placed in front of a passage
 * @property {number} downloadMB      rough download size, for the one sentence shown
 * @property {{ model: string, tokenizer: string }} files
 * @property {{ model: string, tokenizer: string, modelSize: number }} tested   SHA-256 values this version was tested with
 */

export const DEFAULT_MODEL = 'all-MiniLM-L6-v2';

/**
 * The padding a long-lived reader reads questions at. A question's vector is the same at any padding
 * that fits it, and the time to read it grows with the padding, so a process that answers many
 * questions keeps it small. A question that does not fit is read by a reader started at the full length.
 */
export const QUESTION_PAD = 64;

/** @type {Record<string, ModelEntry>} */
export const MODELS = {
  'all-MiniLM-L6-v2': {
    name: 'all-MiniLM-L6-v2',
    dimensions: 384,
    windowTokens: 126,
    budgetTokens: 110,
    maxLength: 128,
    counter: 'wordpiece',
    queryLead: '',
    passageLead: '',
    downloadMB: 90,
    files: { model: 'model.onnx', tokenizer: 'tokenizer.json' },
    tested: {
      model: '6fd5d72fe4589f189f8ebc006442dbb529bb7ce38f8082112682524616046452',
      tokenizer: 'be50c3628f2bf5bb5e3a7f17b1f74611b2561a3a27eeab05e5aa30f411572037',
      modelSize: 90405214,
    },
  },
};

/** @param {string} name @returns {ModelEntry} */
export function modelEntry(name) {
  const entry = MODELS[name];
  if (!entry) throw Object.assign(new Error(`Unknown reading model "${name}". Known: ${Object.keys(MODELS).join(', ')}.`), { code: 'VM_E_USAGE' });
  return entry;
}
