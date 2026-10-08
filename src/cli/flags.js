// @ts-check
// Flag values that more than one command reads. Each is checked here, once, so every command answers a
// mistyped value with the same sentence.
import { VmError } from '../errors.js';

/**
 * `--workers`: "auto", or a whole number of readers. Anything else (a word, a negative number, a
 * fraction, an empty value) is a usage error. `Number()` would have let some of those through: it
 * reads "" as 0 and "0x10" as 16.
 * @param {string | undefined} value the flag as typed, or undefined when it was not given
 * @returns {number | 'auto' | undefined}
 */
export function parseWorkers(value) {
  if (value == null) return undefined;
  if (value === 'auto') return 'auto';
  if (!/^\d+$/.test(value)) throw new VmError('VM_E_USAGE', { detail: '--workers takes a number, for example --workers 2.' });
  return Number(value);
}
