import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULE_BLOCK, RULE_LINE } from '../../src/rule-text.js';
import { PINS, TOOL_VERSION } from '../../src/version.js';
import { DEFAULT_MODEL, MODELS } from '../../src/embed/models.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** @param {string} dir @returns {string[]} */
const sources = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? sources(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []));
/** Code without comments, so a comment may mention what the code must not do. @param {string} text */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the only runtime dependency is ruvector at its pin, and overrides pins @ruvector/core', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.dependencies, { ruvector: PINS.ruvector });
  assert.deepEqual(pkg.overrides, { '@ruvector/core': PINS.core });
  assert.equal(pkg.version, TOOL_VERSION);
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(pkg.type, 'module');
});

test('the shrinkwrap lists all five platform packages at the pinned versions', () => {
  const lock = JSON.parse(read('npm-shrinkwrap.json'));
  for (const name of ['darwin-arm64', 'darwin-x64', 'linux-x64-gnu', 'linux-arm64-gnu', 'win32-x64-msvc']) {
    const entry = lock.packages[`node_modules/ruvector-core-${name}`];
    assert.ok(entry, `ruvector-core-${name} is in the shrinkwrap`);
    assert.equal(entry.version, PINS.native);
  }
  assert.equal(lock.packages['node_modules/ruvector'].version, PINS.ruvector);
  assert.equal(lock.packages['node_modules/@ruvector/core'].version, PINS.core);
});

test('the rule text equals examples/CLAUDE.md and keeps its fixed wording', () => {
  assert.equal(read('examples/CLAUDE.md').trim(), RULE_BLOCK);
  assert.equal(read('examples/AGENTS.md').trim(), RULE_BLOCK);
  assert.ok(RULE_LINE.includes('read the passages it returns'));
  assert.ok(RULE_LINE.includes('If they do not answer the question, search the vault files.'));
  assert.ok(RULE_LINE.includes('Do not read the whole vault.'));
  assert.ok(!/open only/i.test(RULE_LINE));
  assert.ok(!RULE_LINE.includes('\n'), 'one line');
});

test('no source file mentions a compare command or a reading multiplier', () => {
  for (const file of [...sources('src'), ...sources('bin')]) {
    const text = read(file);
    assert.ok(!/\bcompare\b/i.test(code(text)), `${file} mentions compare`);
    assert.ok(!/times less|x fewer|hybrid search|\binstant\b/i.test(text), `${file} makes a claim this project never makes`);
  }
  assert.ok(!fs.existsSync(path.join(ROOT, 'src', 'compare.js')));
});

test('no model name or vector size outside src/embed/', () => {
  const names = [...Object.keys(MODELS), 'MiniLM'];
  for (const file of sources('src')) {
    if (file.startsWith(path.join('src', 'embed'))) continue;
    const text = code(read(file));
    for (const name of names) assert.ok(!text.includes(name), `${file} names the model ${name}`);
    assert.ok(!/\b384\b/.test(text), `${file} contains a vector size`);
    assert.ok(!/\b(126|110)\b/.test(text), `${file} contains a token window or budget`);
  }
  assert.ok(Object.keys(MODELS).includes(DEFAULT_MODEL));
});

test('read-only, static: only safe-write.js references an fs write API, and nothing under src/vault/ imports it', () => {
  const WRITE = /\b(writeFile(Sync)?|appendFile(Sync)?|rename(Sync)?|unlink(Sync)?|rm(Sync)?|rmdir(Sync)?|mkdir(Sync)?|mkdtemp(Sync)?|copyFile(Sync)?|cp(Sync)?|truncate(Sync)?|ftruncate(Sync)?|utimes(Sync)?|futimes(Sync)?|lutimes(Sync)?|chmod(Sync)?|chown(Sync)?|symlink(Sync)?|link(Sync)?|createWriteStream|writeSync|writev(Sync)?|fsync(Sync)?)\s*\(/;
  for (const file of sources('src')) {
    if (file === path.join('src', 'store', 'safe-write.js')) continue;
    const text = code(read(file));
    for (const line of text.split('\n')) {
      // Calls into the safe writer (and the tool's own helpers named after it) are fine; raw fs calls are not.
      const raw = /\bfs(Promises)?\.[A-Za-z]+\s*\(/.exec(line);
      if (raw) assert.ok(!WRITE.test(raw[0]), `${file} calls a raw fs write API: ${line.trim()}`);
      for (const m of line.matchAll(/openSync\s*\(([^)]*)\)/g)) assert.match(m[1], /,\s*'r'\s*$/, `${file} opens a file other than read-only: ${line.trim()}`);
      assert.ok(!/from 'node:fs'/.test(line) || /^import fs from 'node:fs';$|^import \{ (opendirSync|lstatSync|readFileSync|existsSync|statSync)(, (opendirSync|lstatSync|readFileSync|existsSync|statSync))* \} from 'node:fs';$/.test(line.trim()), `${file} imports fs members by name: ${line.trim()}`);
      assert.ok(!/from 'node:fs\/promises'/.test(line) || /^import \{ readFile \} from 'node:fs\/promises';$/.test(line.trim()), `${file} imports fs/promises members other than readFile`);
    }
  }
  for (const file of sources(path.join('src', 'vault'))) assert.ok(!/safe-write/.test(read(file)), `${file} must not import the writer`);
  for (const file of sources(path.join('src', 'chunker'))) assert.ok(!/from '\.\.\//.test(read(file)), `${file}: the chunker imports nothing outside its folder`);
  const ro = code(read(path.join('src', 'vault', 'read-only-fs.js')));
  assert.deepEqual([...ro.matchAll(/\b(opendirSync|lstatSync|readFile)\b/g)].length > 0, true);
  assert.ok(!/fs\./.test(ro), 'read-only-fs uses opendir, lstat and readFile only');
});

test('the repo ignores tool droppings, and the tree holds none', () => {
  const ignore = read('.gitignore');
  for (const line of ['node_modules/', 'ruvector.db', '*.db', '*.rvf', '.claude/', '.claude-flow/', '.swarm/', '*.log', 'vault-index/']) assert.ok(ignore.split(/\r?\n/).includes(line), `.gitignore covers ${line}`);
  /** @param {string} dir @returns {string[]} */
  const all = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (['node_modules', '.git'].includes(d.name) ? [] : d.isDirectory() ? all(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  for (const f of all(ROOT)) assert.ok(!/(^|[\\/])(ruvector\.db|kb\.db)$/.test(f), `${f} must not exist`);
});
