// Preload with `node --require`: wraps every fs write call and throws if its path is under
// the folder named by VM_SPY_ROOT (the vault). Each violation is also written to VM_SPY_LOG.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const root = process.env.VM_SPY_ROOT ? fs.realpathSync.native(process.env.VM_SPY_ROOT) : null;
const rawAppend = fs.appendFileSync;
const rawRealpath = fs.realpathSync.native; // the one true path on every system (letter case and short names on Windows)

function resolve(p) {
  let current = path.resolve(String(p)); const rest = [];
  for (;;) {
    try { const real = rawRealpath(current); return rest.length ? path.join(real, ...rest.reverse()) : real; }
    catch { const parent = path.dirname(current); if (parent === current) return path.resolve(String(p)); rest.push(path.basename(current)); current = parent; }
  }
}
function check(name, p) {
  if (!root || p == null || typeof p === 'number') return;
  if (typeof p !== 'string' && !Buffer.isBuffer(p) && !(p instanceof URL)) return;
  const real = resolve(p instanceof URL ? fileURLToPath(p) : p);
  if (real === root || real.startsWith(root + path.sep)) {
    try { rawAppend(process.env.VM_SPY_LOG || require('node:os').devNull, `${name} ${real}\n`); } catch { /* still throw */ }
    throw new Error(`fs-spy: ${name} on a vault path: ${real}`);
  }
}
const writeFlag = (flags) => (typeof flags === 'number' ? (flags & 3) !== 0 || (flags & (fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0 : typeof flags === 'string' ? /[wa+x]/.test(flags) : false);
const ONE = ['writeFile', 'appendFile', 'unlink', 'rm', 'rmdir', 'mkdir', 'truncate', 'utimes', 'lutimes', 'chmod', 'lchmod', 'chown', 'lchown', 'createWriteStream', 'mkdtemp'];
const TWO = ['rename', 'copyFile', 'symlink', 'link', 'cp'];

function wrap(target, sync) {
  for (const base of ONE) for (const name of sync ? [base, `${base}Sync`] : [base]) {
    const raw = target[name]; if (typeof raw !== 'function') continue;
    target[name] = function (p, ...rest) { check(name, p); return raw.call(this, p, ...rest); };
  }
  for (const base of TWO) for (const name of sync ? [base, `${base}Sync`] : [base]) {
    const raw = target[name]; if (typeof raw !== 'function') continue;
    target[name] = function (a, b, ...rest) { check(name, a); check(name, b); return raw.call(this, a, b, ...rest); };
  }
  for (const name of sync ? ['open', 'openSync'] : ['open']) {
    const raw = target[name]; if (typeof raw !== 'function') continue;
    target[name] = function (p, flags, ...rest) { if (writeFlag(flags)) check(name, p); return raw.call(this, p, flags, ...rest); };
  }
}
wrap(fs, true);
wrap(fs.promises, false);
