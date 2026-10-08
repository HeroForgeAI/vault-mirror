// @ts-check
// `vault-mirror mcp`: run the MCP server on stdio, or print how to add it to an app.
// Unlike every other command it does not exit when it has started: it serves until the client closes its end.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { expandHome } from '../../config/paths.js';
import { VmError } from '../../errors.js';

export const MCP_HELP = `vault-mirror mcp
Runs vault-mirror's MCP server on stdio, so an AI app can search your vault with a named tool.
It only reads your notes. Apps start it for you; you do not run it by hand.

Usage: vault-mirror mcp [options]

  --setup               Print the lines that add the server to Claude Code, Codex and Claude Desktop
  --home <folder>       Use this home folder (the same as setting VAULT_MIRROR_HOME). One per vault
  --vault <folder>      Serve this vault only. Tool calls are refused if another vault is set up here
  --idle-minutes <n>    Keep the reading model loaded this long after a search (default 5)
  --help                Show this help

Tools: search_vault, vault_status, sync_index. More: docs/MCP.md
`;

/**
 * @param {string[]} argv   everything after the program name, "mcp" included
 * @returns {{ setup: boolean, help: boolean, home: string | null, vault: string | null, idleMs: number, extra: string[] }}
 */
export function mcpOptions(argv) {
  /** @type {any} */
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: { setup: { type: 'boolean' }, help: { type: 'boolean' }, home: { type: 'string' }, vault: { type: 'string' }, 'idle-minutes': { type: 'string' } } });
  } catch (e) {
    throw new VmError('VM_E_USAGE', { detail: String(/** @type {any} */ (e).message).split('\n')[0].replace(/^Unknown option '([^']+)'.*$/, 'mcp has no option $1.').replace(/\.?$/, '.') });
  }
  const f = parsed.values;
  if (parsed.positionals.length !== 1) throw new VmError('VM_E_USAGE', { detail: 'mcp takes options only, for example: vault-mirror mcp --setup' });
  const minutes = f['idle-minutes'] == null ? 5 : Number(f['idle-minutes']);
  if (!Number.isFinite(minutes) || minutes < 0) throw new VmError('VM_E_USAGE', { detail: '--idle-minutes takes a number of minutes, for example --idle-minutes 5.' });
  const home = f.home ? expandHome(f.home) : null;
  const vault = f.vault ? expandHome(f.vault) : null;
  /** @type {string[]} */
  const extra = [];
  if (home) extra.push('--home', home);
  if (vault) extra.push('--vault', vault);
  if (f['idle-minutes'] != null) extra.push('--idle-minutes', String(minutes));
  return { setup: Boolean(f.setup), help: Boolean(f.help), home, vault, idleMs: Math.round(minutes * 60000), extra };
}

/**
 * @param {string[]} argv
 * @returns {Promise<{ serving: boolean }>}   serving: the process must stay alive
 */
export async function mcpCommand(argv) {
  const o = mcpOptions(argv);
  if (o.help) { process.stdout.write(MCP_HELP); return { serving: false }; }
  if (o.setup) { process.stdout.write((await import('../../mcp/setup.js')).setupText({ extra: o.extra })); return { serving: false }; }
  if (o.home) {
    // A home folder that was mistyped would look like "no vault is set up" for ever. Say it now, before serving.
    if (fs.existsSync(o.home) && !fs.statSync(o.home).isDirectory()) throw new VmError('VM_E_USAGE', { detail: `--home ${o.home} is a file, not a folder.` });
    process.env.VAULT_MIRROR_HOME = o.home; // every command this server starts uses the same home
  }
  (await import('../../mcp/server.js')).serve({ vault: o.vault, idleMs: o.idleMs });
  return { serving: true };
}
