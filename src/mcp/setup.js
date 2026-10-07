// @ts-check
// `vault-mirror mcp --setup`: prints how to add the server to an app. It prints and nothing else: it
// never opens or edits an app's settings file.
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/vault-mirror.js', import.meta.url));

/** @param {string} s */
const quote = (s) => `"${s}"`;

/**
 * @param {{ extra?: string[], node?: string, bin?: string, name?: string }} [o]   extra: flags to hand the server, such as --home <folder>
 * @returns {string}
 */
export function setupText(o = {}) {
  const node = o.node || process.execPath; const bin = o.bin || BIN; const name = o.name || 'vault-mirror';
  const args = [bin, 'mcp', ...(o.extra || [])];
  const line = [node, ...args].map(quote).join(' ');
  const desktop = JSON.stringify({ mcpServers: { [name]: { command: node, args } } }, null, 2);
  const toml = `[mcp_servers.${name}]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify(args)}`;
  return `Add vault-mirror's MCP server to an app once, and your AI can search your vault from any project.
It only reads your notes. These lines use full paths, so they work in apps that do not know your PATH.

Claude Code (run in a terminal):

  claude mcp add --scope user ${name} -- ${line}

Codex (run in a terminal):

  codex mcp add ${name} -- ${line}

  or add this to ~/.codex/config.toml:

${toml.split('\n').map((l) => '  ' + l).join('\n')}

Claude Desktop: open Settings, then Developer, then Edit Config. Add this "mcpServers" entry
(keep any you already have), save, then quit and reopen the app:

${desktop.split('\n').map((l) => '  ' + l).join('\n')}

Then ask your AI: "Search my vault for ..."
More: docs/MCP.md
`;
}
