// @ts-check
// The MCP server's reader: a child process that holds the reading model so the next question skips
// loading it. It reads questions and nothing else: it opens no index and no vault file. It leaves
// when its parent asks, and by itself the moment its parent is gone.
// Run by src/mcp/reader.js as: node reader-child.js <model> <padding, or 0 for the full length>
import { createEmbedder } from '../embed/embedder.js';
import { toVmError } from '../errors.js';

const [model, pad] = process.argv.slice(2);
/** @param {Record<string, any>} message @param {() => void} [then] */
const send = (message, then) => { try { if (process.send) process.send(message, then ? () => then() : undefined); else if (then) then(); } catch { if (then) then(); } };
/** @param {any} e */
const wire = (e) => { const err = toVmError(e); return { code: err.code, params: err.params }; };

process.on('disconnect', () => process.exit(0)); // the server ended, however it ended

try {
  const embedder = createEmbedder({ model, debug: (line) => send({ debug: line }), notice: (line) => send({ notice: line }) });
  await embedder.init(Number(pad) > 0 ? { pad: Number(pad) } : {}); // a first run downloads the model here
  embedder.questionFits('load the token counter now, not during the first question');
  let chain = Promise.resolve();
  process.on('message', (/** @type {any} */ m) => {
    chain = chain.then(async () => {
      try {
        const queries = /** @type {string[]} */ (m.queries);
        // A question longer than this reader's padding would be cut short. It is sent back unread.
        if (!queries.every((q) => embedder.questionFits(q))) return send({ id: m.id, tooLong: true });
        const vectors = [];
        for (const q of queries) vectors.push(await embedder.embedQuery(q));
        send({ id: m.id, vectors });
      } catch (e) {
        send({ debug: `mcp reader: a question could not be read: ${String(/** @type {any} */ (e)?.message).slice(0, 160)}` });
        send({ id: m.id, error: wire(e) });
      }
    });
  });
  send({ ready: true });
} catch (e) {
  send({ debug: `mcp reader could not start: ${String(/** @type {any} */ (e)?.message).slice(0, 160)}` });
  send({ fatal: wire(e) }, () => process.exit(1));
}
