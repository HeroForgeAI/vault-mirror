import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkOneVault, checkIndexOutside, inCloudFolder } from '../../src/config/guards.js';
import { resolveSafe, isInside, clearPathCache } from '../../src/config/paths.js';
import { chooseWorkers, indexDirFor } from '../../src/config/config.js';
import * as safe from '../../src/store/safe-write.js';
import { projectCheck, applyRule } from '../../src/cli/commands/init.js';
import { RULE_BLOCK } from '../../src/rule-text.js';
import { VmError } from '../../src/errors.js';
import { fileURLToPath } from 'node:url';
import { tmpDir, DIR_LINK } from '../helpers/tmp.mjs';

/** A temp tree with one vault and a folder of two vaults. */
function tree() {
  const root = tmpDir('guards');
  const mk = (/** @type {string} */ rel) => { fs.mkdirSync(path.join(root, rel), { recursive: true }); return path.join(root, rel); };
  const vault = mk('vault'); mk('vault/.obsidian'); mk('vault/Notes/Deep'); fs.writeFileSync(path.join(vault, 'A.md'), 'a');
  mk('many/One/.obsidian'); mk('many/Two/.obsidian'); mk('deep/Level1/Level2/.obsidian'); mk('plain/Sub'); mk('vault2');
  clearPathCache();
  return { root, vault };
}
const code = (/** @type {string} */ c) => (/** @type {any} */ e) => e instanceof VmError && e.code === c && e.exitCode === 2;

test('paths are compared on whole segments, and a path that does not exist yet still resolves', () => {
  const { root, vault } = tree();
  const a = path.join(path.parse(root).root, 'a');
  assert.equal(isInside(path.join(a, 'vault2'), path.join(a, 'vault')), false);
  assert.equal(isInside(path.join(a, 'vault', 'x'), path.join(a, 'vault')), true);
  assert.equal(isInside(path.join(a, 'vault'), path.join(a, 'vault')), true);
  assert.equal(isInside(a, path.parse(root).root), true, 'a parent that already ends in a separator');
  assert.equal(resolveSafe(path.join(vault, 'not', 'yet', 'here')), path.join(vault, 'not', 'yet', 'here'));
  fs.symlinkSync(vault, path.join(root, 'link-to-vault'), DIR_LINK);
  assert.equal(resolveSafe(path.join(root, 'link-to-vault', 'new-home')), path.join(vault, 'new-home'), 'the nearest existing ancestor is resolved through the symlink');
});

test('index in vault and vault in index are refused, also through a symlink and for a home that does not exist yet', () => {
  const { root, vault } = tree();
  assert.throws(() => checkIndexOutside(vault, path.join(vault, '.vault-mirror')), code('VM_E_INDEX_IN_VAULT'));
  assert.throws(() => checkIndexOutside(vault, path.join(vault, 'a', 'b', 'does-not-exist-yet')), code('VM_E_INDEX_IN_VAULT'));
  assert.throws(() => checkIndexOutside(vault, root), code('VM_E_INDEX_IN_VAULT'), 'the vault inside the home folder');
  fs.symlinkSync(path.join(vault, 'Notes'), path.join(root, 'sneaky-home'), DIR_LINK);
  assert.throws(() => checkIndexOutside(vault, path.join(root, 'sneaky-home', 'idx')), code('VM_E_INDEX_IN_VAULT'), 'a symlinked home that lands in the vault');
  assert.equal(checkIndexOutside(vault, path.join(root, 'vault2', 'home')), path.join(root, 'vault2', 'home'), 'a sibling whose name starts the same is fine');
});

test('one vault only: home, root, a folder of vaults and a folder inside a vault are refused', () => {
  const { root, vault } = tree();
  assert.equal(checkOneVault(vault).real, vault);
  assert.equal(checkOneVault(vault).opened, true);
  assert.throws(() => checkOneVault(os.homedir()), code('VM_E_NOT_ONE_VAULT'));
  assert.throws(() => checkOneVault(path.parse(root).root), code('VM_E_NOT_ONE_VAULT'));
  assert.throws(() => checkOneVault(path.join(root, 'many')), code('VM_E_NOT_ONE_VAULT'));
  assert.throws(() => checkOneVault(path.join(root, 'deep')), code('VM_E_NOT_ONE_VAULT'), 'a vault two levels below');
  assert.throws(() => checkOneVault(path.join(vault, 'Notes', 'Deep')), (e) => code('VM_E_NOT_ONE_VAULT')(e) && e.next.includes(vault), 'the message names the vault root to use');
  const plain = checkOneVault(path.join(root, 'plain'));
  assert.equal(plain.opened, false);
  assert.equal(plain.warnings.length, 1, 'no .obsidian anywhere is allowed with a warning');
  assert.throws(() => checkOneVault(path.join(root, 'nope')), (e) => e instanceof VmError && e.code === 'VM_E_VAULT_MISSING' && e.exitCode === 4);
  const many = fileURLToPath(new URL('../fixtures/many-vaults', import.meta.url));
  assert.throws(() => checkOneVault(many), code('VM_E_NOT_ONE_VAULT'), 'the fixture folder of several vaults');
});

test('the only writer: a write or delete outside the two roots throws', () => {
  const { root, vault } = tree();
  const home = path.join(root, 'home');
  const project = path.join(root, 'plain');
  safe.configureWriter({ home, vault, ruleFiles: [path.join(project, 'CLAUDE.md')] });
  safe.ensureDir(home);
  safe.writeFile(path.join(home, 'ok.txt'), 'ok');
  safe.writeFileAtomic(path.join(home, 'sub.json'), '{}');
  safe.writeFile(path.join(project, 'CLAUDE.md'), 'rule');
  const refused = /Refused to write/;
  assert.throws(() => safe.writeFile(path.join(project, 'AGENTS.md'), 'x'), refused, 'a rule file that was not allowed');
  assert.throws(() => safe.writeFile(path.join(project, 'other.md'), 'x'), refused);
  assert.throws(() => safe.writeFile(path.join(vault, 'B.md'), 'x'), refused);
  assert.throws(() => safe.appendFile(path.join(vault, 'A.md'), 'x'), refused);
  assert.throws(() => safe.remove(path.join(vault, 'A.md')), refused, 'deletes go through the same check');
  assert.throws(() => safe.remove(vault), refused);
  assert.throws(() => safe.rename(path.join(home, 'ok.txt'), path.join(vault, 'moved.txt')), refused);
  assert.throws(() => safe.rename(path.join(vault, 'A.md'), path.join(home, 'stolen.md')), refused);
  assert.throws(() => safe.ensureDir(path.join(vault, 'new-folder')), refused);
  assert.throws(() => safe.truncate(path.join(vault, 'A.md'), 0), refused);
  assert.throws(() => safe.openAppend(path.join(vault, 'A.md')), refused);
  assert.throws(() => safe.createExclusive(path.join(root, 'many', 'One', 'x.lock'), 'x'), refused, 'inside a vault that is not the registered one');
  assert.throws(() => safe.writeFile(path.join(root, 'many', 'One', 'CLAUDE.md'), 'x'), refused);
  fs.symlinkSync(vault, path.join(home, 'into-vault'), DIR_LINK);
  assert.throws(() => safe.writeFile(path.join(home, 'into-vault', 'C.md'), 'x'), refused, 'a symlink out of the home folder into the vault');
  assert.equal(fs.readFileSync(path.join(vault, 'A.md'), 'utf8'), 'a');
  assert.deepEqual(fs.readdirSync(vault).sort(), ['.obsidian', 'A.md', 'Notes']);
  safe.resetWriter();
  assert.throws(() => safe.writeFile(path.join(home, 'ok.txt'), 'x'), refused, 'nothing may be written before the home folder is set');
});

test('rename retries when another program briefly holds the file', (t) => {
  const { root } = tree();
  const home = path.join(root, 'home2');
  safe.configureWriter({ home });
  safe.ensureDir(home);
  safe.writeFile(path.join(home, 'a'), '1');
  let fails = 2;
  const real = fs.renameSync;
  t.mock.method(fs, 'renameSync', (/** @type {any} */ a, /** @type {any} */ b) => { if (fails-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return real(a, b); });
  safe.rename(path.join(home, 'a'), path.join(home, 'b'));
  assert.equal(fs.readFileSync(path.join(home, 'b'), 'utf8'), '1');
  assert.equal(fails, -1);
});

test('init writes its rule only into a folder that is not in any vault', () => {
  const { root, vault } = tree();
  assert.equal(projectCheck(path.join(root, 'plain'), vault, []).ok, true);
  assert.equal(projectCheck(vault, vault, []).ok, false);
  assert.equal(projectCheck(path.join(vault, 'Notes'), vault, []).ok, false);
  assert.equal(projectCheck(path.join(root, 'many', 'One'), vault, []).ok, false, 'a second, unregistered vault');
  assert.equal(projectCheck(path.join(root, 'plain'), vault, [path.join(root, 'plain')]).ok, false, 'a vault in Obsidian\'s own list');
  assert.equal(projectCheck(path.join(root, 'missing'), vault, []).ok, false);
});

test('the rule is one block between two markers; a re-run replaces it and touches nothing else', () => {
  assert.deepEqual(applyRule(null), { text: RULE_BLOCK + '\n', action: 'created' });
  const first = applyRule('# My project\n\nKeep this line.\n');
  assert.equal(first.action, 'updated');
  assert.ok(first.text.startsWith('# My project\n\nKeep this line.\n\n<!-- vault-mirror:start -->'));
  assert.equal(applyRule(first.text).action, 'unchanged');
  const old = first.text.replace('Do not read the whole vault.', 'An older wording.') + '\nText after the rule.\n';
  const again = applyRule(old);
  assert.equal(again.action, 'updated');
  assert.ok(again.text.includes(RULE_BLOCK) && again.text.endsWith('\nText after the rule.\n') && !again.text.includes('An older wording.'));
  assert.equal(again.text.split('vault-mirror:start').length, 2, 'never a second copy');
});

test('the rule in a file with Windows line endings: the file keeps them, and a second run changes nothing', () => {
  const before = '# My project\r\n\r\nKeep this line.\r\n';
  const first = applyRule(before);
  assert.equal(first.action, 'updated');
  assert.ok(first.text.startsWith(before), 'what was there is untouched');
  assert.ok(!/[^\r]\n/.test(first.text), `no line of the file ends without a carriage return: ${JSON.stringify(first.text)}`);
  assert.equal(first.text.replace(/\r\n/g, '\n'), '# My project\n\nKeep this line.\n\n' + RULE_BLOCK + '\n', 'the same file as with plain line endings');
  assert.equal(first.text.split('vault-mirror:start').length, 2);
  assert.equal(applyRule(first.text).action, 'unchanged', 'a second run');
  // A file checked out with Windows line endings already holds the rule in that form: it is the rule, not an older wording.
  const checkedOut = ('Intro.\n\n' + RULE_BLOCK + '\nAfter.\n').replace(/\n/g, '\r\n');
  assert.deepEqual(applyRule(checkedOut), { text: checkedOut, action: 'unchanged' });
  // An older wording in such a file is replaced in the file's own line endings.
  const older = applyRule(checkedOut.replace('Do not read the whole vault.', 'An older wording.'));
  assert.deepEqual([older.action, older.text], ['updated', checkedOut]);
  // Plain line endings, and a file that mixes the two, get plain ones as before.
  assert.ok(!applyRule('a\nb\r\n').text.slice(6).includes('\r'));
  assert.ok(!applyRule('').text.includes('\r'));
});

test('worker count is automatic and conservative', () => {
  assert.equal(chooseWorkers('auto', { cores: 16, totalGB: 64 }).workers, 4);
  assert.equal(chooseWorkers('auto', { cores: 8, totalGB: 8 }).workers, 2);
  assert.equal(chooseWorkers('auto', { cores: 8, totalGB: 16 }).workers, 4);
  assert.equal(chooseWorkers('auto', { cores: 4, totalGB: 16 }).workers, 2);
  assert.equal(chooseWorkers('auto', { cores: 8, totalGB: 4 }).workers, 0, 'under 8 GB: no pool');
  assert.equal(chooseWorkers('auto', { cores: 2, totalGB: 16 }).workers, 0, '2 cores: no pool');
  assert.equal(chooseWorkers(12, { cores: 16, totalGB: 64 }).workers, 8, 'a number is capped at 8');
  assert.ok(chooseWorkers(6, { cores: 16, totalGB: 64 }).note, 'above 4 prints one line saying the computer will be busy');
  assert.equal(chooseWorkers(3, { cores: 16, totalGB: 64 }).note, null);
});

test('the index folder name is a safe name plus 8 hex of the real path; cloud folders are recognised', () => {
  const dir = indexDirFor('/h', '/Users/someone/My Notes (2031)!');
  assert.match(path.basename(dir), /^My_Notes__2031__-[0-9a-f]{8}$/);
  assert.notEqual(indexDirFor('/h', '/a/notes'), indexDirFor('/h', '/b/notes'));
  assert.equal(inCloudFolder(path.join(os.homedir(), 'Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents', 'v')), true);
  assert.equal(inCloudFolder(path.join(os.homedir(), 'Documents', 'v')), true);
  assert.equal(inCloudFolder(path.join(os.homedir(), 'Dropbox', 'v')), true);
  assert.equal(inCloudFolder(path.join(os.homedir(), 'Projects', 'v')), false);
});
