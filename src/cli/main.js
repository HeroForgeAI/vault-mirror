// @ts-check
// Parse, dispatch, map errors to exit codes. Every command ends with an explicit exit:
// it never waits for the event loop to empty.
import { parseArgs } from 'node:util';
import { createUi, printJson, printError, flush } from './output.js';
import { release } from '../embed/quiet.js';
import { toVmError, VmError } from '../errors.js';
import { debug } from '../log.js';
import { TOOL_VERSION } from '../version.js';

const HELP = `vault-mirror ${TOOL_VERSION}
Keeps one Obsidian vault and one local index in step, so your AI searches the index first.
It only reads your notes.

Usage: vault-mirror <command> [options]

Commands:
  init <vault-path>     Set the vault and write the one-line rule for your AI
  sync                  Bring the index in step with the vault
  search "<question>"   Ask the index, by meaning and by exact words; two or three wordings in one call work best
  status                Is my vault in sync?
  rebuild               Rebuild the index from saved passages. Always safe
  doctor                Check that this computer is ready
  mcp                   Run the MCP server, so an AI app searches with a named tool (mcp --setup shows how to add it)

Options for every command:
  --json       Print one JSON object and nothing else
  --quiet      Print results only
  --no-color   Plain text
  --help       Show this help
  --version    Show the version

init:     --project <dir>  --no-rule  --exclude <folder> (repeatable)
sync:     --detach  --workers <n>  --full-speed  --wait <seconds>  --allow-mass-delete  --verify
search:   -k, --count <n>  --no-sync  --no-exact-words
status:   --verify  --list  --screen
rebuild:  --full  --yes
mcp:      --setup  --home <dir>  --vault <dir>  --idle-minutes <n>
`;

/** @type {Record<string, any>} */
const COMMON = { json: { type: 'boolean' }, quiet: { type: 'boolean' }, 'no-color': { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' } };
/** @type {Record<string, Record<string, any>>} */
const OPTIONS = {
  init: { project: { type: 'string' }, 'no-rule': { type: 'boolean' }, exclude: { type: 'string', multiple: true } },
  sync: { detach: { type: 'boolean' }, workers: { type: 'string' }, 'full-speed': { type: 'boolean' }, wait: { type: 'string' }, 'allow-mass-delete': { type: 'boolean' }, verify: { type: 'boolean' } },
  search: { count: { type: 'string', short: 'k' }, 'no-sync': { type: 'boolean' }, 'no-exact-words': { type: 'boolean' } },
  status: { verify: { type: 'boolean' }, list: { type: 'boolean' }, screen: { type: 'boolean' } },
  rebuild: { full: { type: 'boolean' }, yes: { type: 'boolean' }, workers: { type: 'string' }, 'full-speed': { type: 'boolean' } },
  doctor: {},
};

/** @param {string[]} argv */
export async function main(argv) {
  const command = argv.find((a) => !a.startsWith('-')) || '';
  const json = argv.includes('--json');
  /** @type {{ name: string, path: string } | null} */
  let vault = null;
  let ui = createUi({ json });
  let exitCode = 0;
  try {
    if (argv.includes('--version') && !command) { process.stdout.write(TOOL_VERSION + '\n'); return finish(0); }
    if (command === 'mcp') {
      // Its own options and its own lifetime: it serves until the client closes its end, so there is no exit here.
      if ((await (await import('./commands/mcp.js')).mcpCommand(argv)).serving) return;
      return finish(0);
    }
    if (!command || argv.includes('--help') || command === 'help') { process.stdout.write(HELP); return finish(command || argv.includes('--help') ? 0 : 2); }
    if (!OPTIONS[command]) throw new VmError('VM_E_USAGE', { detail: `"${command}" is not a vault-mirror command.` });
    /** @type {any} */
    let parsed;
    try { parsed = parseArgs({ args: argv, options: { ...COMMON, ...OPTIONS[command] }, allowPositionals: true, strict: true }); }
    catch (e) {
      const unknown = /** @type {any} */ (e).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && /^Unknown option '([^']+)'/.exec(String(/** @type {any} */ (e).message));
      if (unknown) throw new VmError('VM_E_USAGE', { detail: `${command} has no option ${unknown[1]}.` }); // not Node's own sentence about positional arguments
      throw new VmError('VM_E_USAGE', { detail: String(/** @type {any} */ (e).message).split('\n')[0].replace(/\.?$/, '.') });
    }
    const f = parsed.values; const rest = parsed.positionals.slice(1);
    if (f.version) { process.stdout.write(TOOL_VERSION + '\n'); return finish(0); }
    ui = createUi({ json: f.json, quiet: f.quiet });
    /** @type {{ vault: { name: string, path: string } | null, body: Record<string, any>, exitCode?: number }} */
    let result;
    if (command === 'init') {
      if (rest.length !== 1) throw new VmError('VM_E_USAGE', { detail: 'init takes the folder of your vault, for example: vault-mirror init ~/Obsidian/notes' });
      result = await (await import('./commands/init.js')).initCommand({ vaultPath: rest[0], project: f.project, noRule: f['no-rule'], exclude: f.exclude }, ui);
    } else if (command === 'sync') {
      if (rest.length) throw new VmError('VM_E_USAGE', { detail: 'sync takes no folder. It syncs the vault that init set up.' });
      result = await (await import('./commands/sync.js')).syncCommand({ detach: f.detach, workers: f.workers, fullSpeed: f['full-speed'], wait: f.wait, allowMassDelete: f['allow-mass-delete'], verify: f.verify }, ui);
    } else if (command === 'search') {
      result = await (await import('./commands/search.js')).searchCommand({ queries: rest, count: f.count, noSync: f['no-sync'], noExactWords: f['no-exact-words'] }, ui);
    } else if (command === 'status') {
      result = await (await import('./commands/status.js')).statusCommand({ verify: f.verify, list: f.list, screen: f.screen }, ui);
    } else if (command === 'rebuild') {
      result = await (await import('./commands/rebuild.js')).rebuildCommand({ full: f.full, yes: f.yes, workers: f.workers, fullSpeed: f['full-speed'] }, ui);
    } else {
      result = await (await import('./commands/doctor.js')).doctorCommand(ui);
    }
    vault = result.vault;
    exitCode = result.exitCode || 0;
    if (ui.json) printJson(command, vault, result.body, ui.warnings);
  } catch (e) {
    release();
    const err = toVmError(e);
    if (err.code === 'VM_E_INTERNAL') debug(`internal error in ${command}: ${String(/** @type {any} */ (e)?.stack || e).replace(/\n/g, ' | ').slice(0, 2000)}`);
    if (process.env.VAULT_MIRROR_DEBUG && err.code === 'VM_E_INTERNAL') process.stderr.write(String(/** @type {any} */ (e)?.stack || e) + '\n');
    if (ui.json && !vault && command !== 'init') {
      // The command failed before it could name its vault. An error still says which vault it was about.
      try { const c = (await import('./context.js')).loadContext({ needVault: false }); if (c.vault) vault = { name: c.vault.name, path: c.vault.real }; } catch { /* no usable vault: null is the truth */ }
    }
    printError(err, { json: ui.json, command, vault, warnings: ui.warnings });
    exitCode = err.exitCode;
  }
  return finish(exitCode);
}

/** Flush stdout and stderr, then exit. A pool left running would otherwise keep Node alive. @param {number} code */
function finish(code) {
  release();
  flush(() => process.exit(code));
}
