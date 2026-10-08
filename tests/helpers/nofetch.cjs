// Preload with `node --require`: every fetch() fails the way a computer with no network fails,
// and each attempt is written to the file named by VM_NOFETCH_LOG.
const fs = require('node:fs');
globalThis.fetch = async (url) => {
  try { fs.appendFileSync(process.env.VM_NOFETCH_LOG || require('node:os').devNull, `${String(url).slice(0, 200)}\n`); } catch { /* keep failing the fetch */ }
  const e = new TypeError('fetch failed');
  e.cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
  throw e;
};
