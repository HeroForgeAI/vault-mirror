// @ts-check
// vault-mirror's MCP server: the tools of tools.js over stdio, on the official SDK.
// Standard output is the protocol channel. From the moment the server starts, only the protocol
// writes there; every other line (a library's chatter, a notice) goes to stderr or the debug log.
import { Writable } from 'node:stream';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
import { holdAlways, rawOut, writeErr } from '../embed/quiet.js';
import { toVmError, VmError } from '../errors.js';
import { debug } from '../log.js';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';
import { TOOLS, INSTRUCTIONS, WAIT_DEFAULT, WAIT_MAX, wordings } from './tools.js';
import { createReader } from './reader.js';
import { createSession } from './session.js';
import { vaultStatus, syncIndex, stopCommands } from './cli.js';
import { locate } from './where.js';

/**
 * @typedef {object} Backend   what the tools call. Tests pass a stand-in
 * @property {(args: { query: string, other_wordings?: string[], limit?: number }) => Promise<Record<string, any>>} search
 * @property {() => Promise<Record<string, any>>} status
 * @property {(args: { wait_seconds?: number }) => Promise<Record<string, any>>} sync
 */

/** In a tool's answer the next step is a tool, not a shell command, wherever a tool can do it. */
const NEXT = {
  VM_E_NOT_SYNCED: 'Call sync_index, then search again.',
  VM_E_NO_VAULT: 'Ask the person to run `vault-mirror init "<path to their vault>"` in a terminal, then call sync_index.',
  VM_E_BUSY: 'Call vault_status to see how far it is, then try again.',
  VM_E_LOCK_LOST: 'Call vault_status.',
};

/** One plain sentence and one next step, whatever was thrown. @param {any} e @returns {{ code: string, message: string, next: string }} */
export function problem(e) {
  if (e && e.fromCommand) return { code: String(e.code), message: String(e.message), next: /** @type {Record<string, string>} */ (NEXT)[e.code] || String(e.next) };
  const err = toVmError(e);
  if (err.code === 'VM_E_INTERNAL') debug(`mcp internal error: ${String(/** @type {any} */ (e)?.stack || e).replace(/\n/g, ' | ').slice(0, 2000)}`);
  return { code: err.code, message: err.message, next: /** @type {Record<string, string>} */ (NEXT)[err.code] || err.next };
}

/**
 * The server with its tools registered. It knows nothing about stdio.
 * @param {Backend} backend
 */
export function buildServer(backend) {
  const server = new McpServer({ name: TOOL_NAME, version: TOOL_VERSION }, { instructions: INSTRUCTIONS });
  for (const tool of TOOLS) {
    server.registerTool(tool.name, {
      title: tool.title, description: tool.description, annotations: tool.annotations,
      inputSchema: fromJsonSchema(/** @type {any} */ (tool.inputSchema)), outputSchema: fromJsonSchema(/** @type {any} */ (tool.outputSchema)),
    }, async (/** @type {any} */ args) => {
      try {
        const out = await backend[tool.method](args || {});
        return { content: [{ type: /** @type {const} */ ('text'), text: JSON.stringify(out) }], structuredContent: out };
      } catch (e) {
        const p = problem(e);
        return { isError: true, content: [{ type: /** @type {const} */ ('text'), text: `${p.message}\nNext: ${p.next}` }] };
      }
    });
  }
  return server;
}

/**
 * The real backend: the vault and index of this computer.
 * @param {{ vault?: string | null, idleMs: number }} opts
 * @returns {Backend & { close: () => void, readerPid: () => number | null }}
 */
export function createBackend(opts) {
  const reader = createReader({ idleMs: opts.idleMs, debug, notice: (line) => writeErr(line + '\n') });
  const session = createSession({ reader, debug });
  const pin = { vault: opts.vault };
  /** @type {Promise<any>} */
  let syncs = Promise.resolve(); // one sync_index call at a time, so two calls can never each start a sync
  return {
    async search(args) {
      const queries = wordings(args);
      if (!queries.length) throw new VmError('VM_E_USAGE', { detail: 'The question was empty.' });
      return session.search(locate(pin), { queries, count: args.limit });
    },
    async status() {
      locate(pin);
      return vaultStatus();
    },
    async sync(args) {
      const wait = Number.isFinite(args.wait_seconds) ? Math.max(0, Math.min(WAIT_MAX, Number(args.wait_seconds))) : WAIT_DEFAULT;
      const run = syncs.then(() => syncIndex(locate(pin), { waitSeconds: wait }));
      syncs = run.catch(() => {});
      return run;
    },
    close() { reader.stop(); stopCommands(); session.close(); },
    readerPid: () => reader.pid(),
  };
}

/**
 * Serve over stdio until the client closes its end.
 * @param {{ vault?: string | null, idleMs: number }} opts
 */
export function serve(opts) {
  // Before anything else can print: stdout now belongs to the protocol.
  holdAlways(debug);
  const protocolOut = new Writable({ decodeStrings: false, write(chunk, _encoding, done) { rawOut(chunk, (err) => done(err || undefined)); } });
  const backend = createBackend(opts);
  let closing = false;
  const close = (/** @type {number} */ code) => {
    if (closing) return; closing = true;
    backend.close();
    const leave = () => process.exit(code);
    handle.close().then(leave, leave);
    setTimeout(leave, 1000).unref(); // a client that never drains its pipe must not keep this alive
  };
  const handle = serveStdio(() => buildServer(backend), {
    transport: new StdioServerTransport(process.stdin, protocolOut),
    onerror: (e) => debug(`mcp protocol error: ${String(e?.message).slice(0, 200)}`),
  });
  // The client closing its end is the normal way this ends.
  process.stdin.on('end', () => close(0));
  process.stdin.on('close', () => close(0));
  process.stdout.on('error', () => close(0));
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(/** @type {NodeJS.Signals} */ (s), () => close(0));
  process.on('uncaughtException', (e) => { debug(`mcp uncaught: ${String(e?.stack || e).replace(/\n/g, ' | ').slice(0, 2000)}`); close(1); });
  process.on('unhandledRejection', (e) => { debug(`mcp unhandled rejection: ${String(/** @type {any} */ (e)?.stack || e).replace(/\n/g, ' | ').slice(0, 2000)}`); });
  // Nothing about the vault is checked here: a server that starts before `init` has run says so, in one
  // plain sentence with one next step, as the answer to its first tool call, where the person's AI can read it.
  writeErr(`${TOOL_NAME} ${TOOL_VERSION} MCP server ready on stdio. It only reads your notes.\n`);
}
