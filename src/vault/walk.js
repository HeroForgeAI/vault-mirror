// @ts-check
// Walks a vault and lists its notes. Reads names, sizes and dates only.
import path from 'node:path';
import { walk, stat } from './read-only-fs.js';
import { readObsidianExcludes } from './obsidian-registry.js';

/**
 * @typedef {{ key: string, file: string, abs: string, size: number, mtimeMs: number }} NoteFile   `file` is the vault-relative path as spelled on disk, forward slashes
 * @typedef {{ key: string, reason: string, size: number, mtimeMs: number, abs: string | null }} LeftOutFile
 * @typedef {object} WalkResult
 * @property {NoteFile[]} notes          notes that belong in the index, as far as names can tell
 * @property {LeftOutFile[]} leftOut     notes left out by name or place
 * @property {number} otherFiles         images, PDFs, canvases and the like: counted, never read
 * @property {string[]} warnings
 * @property {string[]} unreadableDirs   folders that could not be listed (vault-relative)
 * @property {string[]} unmatchedExcludes `exclude` entries that matched no folder or note, as written
 */

/** The manifest key for a vault-relative path: forward slashes, NFC, no-break spaces as ordinary spaces. @param {string} rel */
export function noteKeyOf(rel) {
  return rel.split(path.sep).join('/').normalize('NFC').replace(/\u00a0/g, ' ');
}

/**
 * An `exclude` entry as a vault key: forward slashes, no `./`, no outer slashes, and a full path
 * to a folder of this vault made relative to it. Any other path with a leading slash is read as
 * starting at the vault folder. '' when it names nothing inside the vault.
 * @param {string} root the vault's real path
 * @param {string} entry
 * @param {{ isAbsolute(p: string): boolean, relative(a: string, b: string): string, normalize(p: string): string, sep: string }} [p] the platform's path rules
 */
export function excludePath(root, entry, p = path) {
  if (typeof entry !== 'string' || !entry) return '';
  let rel = entry;
  if (p.isAbsolute(entry)) {
    const inside = p.relative(root, entry) || '.';
    if (inside === '.' || !(inside === '..' || inside.startsWith('..' + p.sep) || p.isAbsolute(inside))) rel = inside;
  }
  const key = noteKeyOf(p.normalize(rel).split(p.sep).join('/')).replace(/^\/+|\/+$/g, '');
  return key === '.' || key === '..' || key.startsWith('../') ? '' : key;
}

/** Why an entry that matched nothing is worth a line: the person believes that folder is left out. @param {string} entry */
export function unmatchedExcludeNote(entry) {
  return `"${entry}" is set to be left out, but this vault has no folder or note with that name, so nothing is left out for it. Check the spelling under "exclude" in config.json.`;
}

/**
 * @param {string} root   the vault's real path
 * @param {{ exclude?: string[], obsidianExcludes?: boolean }} [opts]
 * @returns {WalkResult}
 */
export function walkVault(root, opts = {}) {
  // Letter case is ignored, as for Obsidian's own excludes: on a Mac or Windows disk "private" is the folder "Private".
  // A name that starts with a dot is always left out, so such an entry never counts as a miss.
  const exclude = (opts.exclude || []).map((raw) => { const key = excludePath(root, raw).toLowerCase(); return { raw, key, hit: key.split('/').some((seg) => seg.startsWith('.')) }; });
  /** Is this key under an `exclude` entry? Every entry that matches is marked as used. @param {string} key */
  const underAny = (key) => {
    const k = key.toLowerCase(); let any = false;
    for (const x of exclude) if (x.key && (k === x.key || k.startsWith(x.key + '/'))) { x.hit = true; any = true; }
    return any;
  };
  /** @type {WalkResult} */
  const result = { notes: [], leftOut: [], otherFiles: 0, warnings: [], unreadableDirs: [], unmatchedExcludes: [] };
  const obsidian = opts.obsidianExcludes === false ? { test: () => false, warning: null } : readObsidianExcludes(root);
  if (obsidian.warning) result.warnings.push(obsidian.warning);
  /** @type {Map<string, true>} */
  const seen = new Map();

  /** @param {string} dir @param {string} rel @param {string | null} forced a reason that applies to everything below */
  function visit(dir, rel, forced) {
    /** @type {import('./read-only-fs.js').Entry[]} */
    let entries;
    try { entries = walk(dir); } catch { result.unreadableDirs.push(rel || '.'); return; }
    for (const e of entries) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      const stub = /^\.(.+\.md)\.icloud$/i.exec(e.name);
      if (stub) { // a cloud stub: the note is present, not downloaded
        const key = noteKeyOf(rel ? path.join(rel, stub[1]) : stub[1]);
        result.leftOut.push({ key, reason: 'not-downloaded', size: 0, mtimeMs: 0, abs: null });
        continue;
      }
      if (e.name.startsWith('.')) continue;
      const isNote = /\.md$/i.test(e.name);
      if (e.isSymlink) {
        if (isNote) result.leftOut.push({ key: noteKeyOf(childRel), reason: 'symlink', size: 0, mtimeMs: 0, abs: null });
        else result.otherFiles++;
        continue;
      }
      if (e.isDir) {
        const key = noteKeyOf(childRel);
        const nested = !forced && Boolean(stat(path.join(e.abs, '.obsidian'))?.isDir);
        const excluded = underAny(key);
        visit(e.abs, childRel, forced || (nested ? 'nested-vault' : excluded ? 'excluded' : null));
        continue;
      }
      if (!e.isFile) continue;
      if (!isNote) { result.otherFiles++; continue; }
      const key = noteKeyOf(childRel);
      const s = stat(e.abs);
      if (!s) continue; // it vanished between the listing and the stat
      const excluded = underAny(key);
      const reason = forced || (excluded ? 'excluded' : obsidian.test(key) ? 'obsidian-excluded' : seen.has(key) ? 'duplicate-path' : null);
      if (reason) { result.leftOut.push({ key, reason, size: s.size, mtimeMs: s.mtimeMs, abs: e.abs }); continue; }
      seen.set(key, true);
      result.notes.push({ key, file: childRel.split(path.sep).join('/'), abs: e.abs, size: s.size, mtimeMs: s.mtimeMs });
    }
  }
  visit(root, '', null);
  result.unmatchedExcludes = exclude.filter((x) => !x.hit).map((x) => x.raw);
  for (const raw of result.unmatchedExcludes) result.warnings.push(unmatchedExcludeNote(raw));
  return result;
}
