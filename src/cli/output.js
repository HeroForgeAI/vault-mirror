// @ts-check
// Human and JSON writers, and the progress line. Every line the tool prints leaves through here.
import { writeOut, writeErr } from '../embed/quiet.js';
import { TOOL_VERSION, SCHEMA } from '../version.js';

/** 18400 -> "18,400". @param {number} n */
export function num(n) { return Math.round(n).toLocaleString('en-US'); }

/** 490 -> "8 min 10 s"; 1.42 -> "1.4 s". @param {number} seconds */
export function duration(seconds) {
  // Under a tenth of a second, one decimal would print "0.0 s"; show hundredths instead.
  if (seconds < 0.095) return `${Math.max(0.01, seconds).toFixed(2)} s`;
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  // Round once, then split: rounding the leftover seconds printed "60 s" and "59 min 60 s".
  const total = Math.round(seconds);
  if (total < 60) return `${total} s`;
  const m = Math.floor(total / 60); const s = total % 60;
  if (m < 60) return s ? `${m} min ${s} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** "about 5 min left". @param {number} seconds */
export function eta(seconds) {
  if (seconds < 50) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} s left`;
  return `about ${Math.max(1, Math.round(seconds / 60))} min left`;
}

/** @param {number} n @param {string} one @param {string} [many] */
export function plural(n, one, many) { return `${num(n)} ${n === 1 ? one : many || one + 's'}`; }

/**
 * @typedef {object} Ui
 * @property {boolean} json
 * @property {(line?: string) => void} out      a result line (stdout in human mode)
 * @property {(line: string) => void} info      progress and notices (stderr in human mode)
 * @property {(line: string) => void} warn      a notice that also lands in the JSON warnings list
 * @property {(p: { done: number, total: number, rate: number, etaSeconds: number | null }) => void} progress
 * @property {() => void} progressEnd
 * @property {string[]} warnings
 * @property {boolean} tty
 */

/**
 * @param {{ json?: boolean, quiet?: boolean, color?: boolean }} flags
 * @returns {Ui}
 */
export function createUi(flags) {
  const json = Boolean(flags.json);
  const quiet = Boolean(flags.quiet);
  const tty = Boolean(process.stderr.isTTY);
  /** @type {string[]} */
  const warnings = [];
  let drawn = false; let lastLineAt = 0; let lastPercent = -100;
  const clear = () => { if (drawn) { writeErr('\r\x1b[2K'); drawn = false; } };
  return {
    json, warnings, tty,
    out(line = '') { if (!json) { clear(); writeOut(line + '\n'); } },
    info(line) { if (!json && !quiet) { clear(); writeErr(line + '\n'); } },
    warn(line) { warnings.push(line); if (!json) { clear(); writeErr(line + '\n'); } },
    progress(p) {
      if (json || quiet || p.total <= 0) return;
      const percent = Math.floor((p.done / p.total) * 100);
      let line = `Reading ${percent}% · ${num(p.done)} of ${num(p.total)} passages`;
      if (p.rate > 0) line += ` · ${p.rate >= 10 ? Math.round(p.rate) : p.rate.toFixed(1)}/s`;
      if (p.etaSeconds != null && p.done >= 64 && p.done < p.total) line += ` · ${eta(p.etaSeconds)}`;
      if (tty) { writeErr(`\r\x1b[2K${line}`); drawn = true; return; }
      const now = Date.now();
      if (now - lastLineAt >= 10000 || percent - lastPercent >= 5) { writeErr(line + '\n'); lastLineAt = now; lastPercent = percent; }
    },
    progressEnd() { clear(); },
  };
}

/**
 * Print the one JSON object of a --json run.
 * @param {string} command
 * @param {{ name: string, path: string } | null} vault
 * @param {Record<string, any>} body
 * @param {string[]} warnings
 */
export function printJson(command, vault, body, warnings) {
  writeOut(JSON.stringify({ schema: SCHEMA, ok: true, command, version: TOOL_VERSION, vault, warnings, ...body }) + '\n');
}

/**
 * Print an error: one plain sentence, then exactly one next action.
 * @param {import('../errors.js').VmError} err
 * @param {{ json: boolean, command: string, vault: { name: string, path: string } | null, warnings?: string[] }} o
 */
export function printError(err, o) {
  if (o.json) {
    writeOut(JSON.stringify({ schema: SCHEMA, ok: false, command: o.command, version: TOOL_VERSION, vault: o.vault, warnings: o.warnings || [], error: { code: err.code, message: err.message, next: err.next, exitCode: err.exitCode } }) + '\n');
  } else {
    writeErr(`${err.message}\nNext: ${err.next}\n`);
  }
}

/** Flush both streams, then call back. */
export function flush(/** @type {() => void} */ done) {
  let waiting = 2;
  const one = () => { if (--waiting === 0) done(); };
  process.stdout.write('', one); process.stderr.write('', one);
}
