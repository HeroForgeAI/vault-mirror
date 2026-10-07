// Helpers for the MCP server's tests: a checksum listing of a vault, and a way to speak the protocol
// over raw stdio so every byte the server prints can be looked at.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BIN = fileURLToPath(new URL('../../bin/vault-mirror.js', import.meta.url));
export const FIXTURE_VAULT = fileURLToPath(new URL('../fixtures/vault', import.meta.url));
export const FS_SPY = fileURLToPath(new URL('./fs-spy.cjs', import.meta.url));

/**
 * Every file and folder under a vault: its path, size, content fingerprint and modified time. Two
 * listings are equal only when nothing was created, changed, moved, touched or removed.
 * @param {string} dir
 * @returns {string}
 */
export function vaultListing(dir) {
  /** @type {string[]} */
  const lines = [];
  const walk = (/** @type {string} */ at) => {
    for (const d of fs.readdirSync(at, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(at, d.name); const rel = path.relative(dir, abs).split(path.sep).join('/');
      const s = fs.lstatSync(abs);
      if (d.isDirectory()) { lines.push(`dir  ${rel}`); walk(abs); }
      else lines.push(`file ${rel} ${s.size} ${Math.floor(s.mtimeMs)} ${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`);
    }
  };
  walk(dir);
  return lines.join('\n');
}

/** @param {string} from @param {string} to */
export function copyVault(from, to) {
  fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
  return fs.realpathSync.native(to); // the one true path, as the tool itself resolves it (a short name such as RUNNER~1 on Windows)
}

/** @param {number} pid */
export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === 'EPERM'; }
}

/** @param {() => boolean} done @param {number} ms */
export async function waitFor(done, ms) {
  const end = Date.now() + ms;
  while (!done()) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 50)); }
  return true;
}

/**
 * Start `vault-mirror mcp` and speak newline-delimited JSON-RPC to it by hand.
 * @param {string[]} args @param {Record<string, string | undefined>} env
 */
export function startRaw(args, env) {
  const child = spawn(process.execPath, [BIN, 'mcp', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; let err = ''; let buf = ''; let nextId = 1;
  /** @type {Map<number, (message: any) => void>} */
  const waiting = new Map();
  /** @type {Promise<number | null>} */
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    out += d; buf += d;
    for (let at = buf.indexOf('\n'); at >= 0; at = buf.indexOf('\n')) {
      const line = buf.slice(0, at); buf = buf.slice(at + 1);
      try { const m = JSON.parse(line); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } } catch { /* the caller checks every line */ }
    }
  });
  child.stderr.on('data', (d) => { err += d; });
  const send = (/** @type {Record<string, any>} */ message) => child.stdin.write(JSON.stringify(message) + '\n');
  return {
    child,
    /** @param {string} method @param {Record<string, any>} [params] @returns {Promise<any>} */
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no answer to ${method} in 120 s; stderr: ${err.slice(0, 500)}`)), 120000);
        waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
        send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
      });
    },
    /** @param {string} method */
    notify(method) { send({ jsonrpc: '2.0', method }); },
    /** The handshake every client opens with. */
    async open() {
      const hello = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-test', version: '1' } });
      this.notify('notifications/initialized');
      return hello;
    },
    /** @param {string} name @param {Record<string, any>} [args] */
    async call(name, args = {}) { return (await this.request('tools/call', { name, arguments: args })).result; },
    stdout: () => out,
    stderr: () => err,
    /** Close the client's end, as an app does when it quits, and wait for the server to leave. */
    async end() { child.stdin.end(); return exited; },
    exited,
  };
}

/** Every line the server printed on stdout must be one JSON-RPC message. Returns the lines that are not. @param {string} out */
export function strayLines(out) {
  return out.split('\n').filter((l) => l.length).filter((l) => { try { return JSON.parse(l).jsonrpc !== '2.0'; } catch { return true; } });
}
