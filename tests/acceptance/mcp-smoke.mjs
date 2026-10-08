// A short conversation with a copy of `vault-mirror mcp` over stdio, by hand, with nothing but Node:
// the handshake, the list of tools, and one call of each. It prints one JSON line and exits.
// The first-run test runs it against the installed copy, so the MCP SDK is proved to install and load
// from the README's install line on every system. Run as: node mcp-smoke.mjs <path to bin/vault-mirror.js> "<question>"
import { startRaw, strayLines } from '../helpers/mcp.mjs';

const [bin, question] = process.argv.slice(2);
const server = startRaw([], process.env, bin);
/** @type {Record<string, any>} */
const out = {};
try {
  const hello = await server.open();
  out.server = hello.result.serverInfo;
  const list = await server.request('tools/list');
  out.tools = list.result.tools.map((/** @type {any} */ t) => t.name);
  out.acceptedFields = list.result.tools.flatMap((/** @type {any} */ t) => Object.keys(t.inputSchema.properties || {}));
  const search = await server.call('search_vault', { query: question, limit: 1 });
  out.search = search.isError ? { error: search.content[0].text } : { top: search.structuredContent.results[0] || null, index: search.structuredContent.index };
  const refused = await server.call('search_vault', { query: question, path: 'New note.md', text: 'x' });
  out.pathRefused = refused.isError === true;
  const status = await server.call('vault_status');
  out.status = status.isError ? { error: status.content[0].text } : { inStep: status.structuredContent.inStep, notesInIndex: status.structuredContent.notesInIndex };
  const sync = await server.call('sync_index', { wait_seconds: 45 });
  out.sync = sync.isError ? { error: sync.content[0].text } : { started: sync.structuredContent.started, finished: sync.structuredContent.finished, inStep: sync.structuredContent.inStep };
  out.exit = await server.end();
  out.stray = strayLines(server.stdout());
} catch (e) {
  out.failed = String(/** @type {any} */ (e)?.message || e).slice(0, 400);
  server.child.kill();
}
console.log(JSON.stringify(out));
process.exit(out.failed ? 1 : 0);
