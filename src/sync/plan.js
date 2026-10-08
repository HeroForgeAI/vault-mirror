// @ts-check
// The plan phase: decide what changed. No embedding, no engine.
import crypto from 'node:crypto';
import { noteKey } from '../log.js';
import { VmError } from '../errors.js';
import { fileOf } from '../store/manifest.js';

/**
 * @typedef {object} PlannedNote
 * @property {string} key
 * @property {string} file                 the vault-relative path as spelled on disk
 * @property {string} abs
 * @property {string} sha256
 * @property {number} size
 * @property {number} mtimeMs
 * @property {boolean} racy
 * @property {boolean} folderInPrefix
 * @property {string} title
 * @property {import('../chunker/index.js').Passage[]} passages
 * @property {'added' | 'updated'} kind
 *
 * @typedef {object} Plan
 * @property {number} seen                 notes on disk, left-out ones included
 * @property {number} eligible             notes that belong in the index
 * @property {number} unchanged
 * @property {{ key: string, size: number, mtimeMs: number, racy: boolean }[]} touched   same content, new date
 * @property {{ key: string, file: string }[]} respelled   same note, and the manifest does not hold its name as the disk spells it
 * @property {PlannedNote[]} toEmbed
 * @property {string[]} removed            gone from disk (renamed-from paths included)
 * @property {{ key: string, reason: string }[]} dropped   in the index, now left out
 * @property {{ from: string, to: string }[]} renamed
 * @property {Record<string, number>} leftOut            reason -> count
 * @property {{ key: string, reason: string }[]} leftOutList
 * @property {Record<string, { reason: string, size: number, mtimeMs: number, racy?: boolean }>} leftOutKept   the manifest's next leftOut map
 * @property {{ key: string, reason: string }[]} skipped
 * @property {number} otherFiles
 * @property {{ new: number, changed: number, removed: number }} pending
 * @property {{ key: string, kind: 'new' | 'changed' | 'removed' }[]} pendingList
 * @property {number} passagesToEmbed
 * @property {number} leaving              notes leaving the index, renames not counted
 * @property {string[]} warnings
 * @property {string[]} unmatchedExcludes  `exclude` entries that matched nothing in the vault
 */

/** @param {Uint8Array} bytes */
export function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

/**
 * @param {object} o
 * @param {import('../vault/walk.js').WalkResult} o.walk
 * @param {import('../store/manifest.js').Manifest | null} o.manifest
 * @param {(abs: string) => Promise<Uint8Array>} o.read
 * @param {(abs: string) => { size: number, mtimeMs: number } | null} o.stat
 * @param {(bytes: Uint8Array, key: string, folderInPrefix: boolean) => import('../chunker/index.js').Chunked} o.chunk
 * @param {boolean} [o.verify]    hash every note, ignore the fast path
 * @param {boolean} [o.shallow]   never read a note: classify by size and date only (status, and a search's first look)
 * @param {number} [o.now]
 * @returns {Promise<Plan>}
 */
export async function buildPlan(o) {
  const now = o.now ?? Date.now();
  const notes = o.manifest ? o.manifest.notes : {};
  const keptLeftOut = o.manifest ? o.manifest.leftOut : {};
  /** @type {Plan} */
  const plan = {
    seen: o.walk.notes.length + o.walk.leftOut.length, eligible: 0, unchanged: 0, touched: [], respelled: [], toEmbed: [], removed: [], dropped: [], renamed: [],
    leftOut: {}, leftOutList: [], leftOutKept: {}, skipped: [], otherFiles: o.walk.otherFiles,
    pending: { new: 0, changed: 0, removed: 0 }, pendingList: [], passagesToEmbed: 0, leaving: 0, warnings: [...o.walk.warnings], unmatchedExcludes: [...(o.walk.unmatchedExcludes || [])],
  };
  const leaveOut = (/** @type {string} */ key, /** @type {string} */ reason) => {
    plan.leftOut[reason] = (plan.leftOut[reason] || 0) + 1;
    plan.leftOutList.push({ key, reason });
  };
  const pend = (/** @type {string} */ key, /** @type {'new' | 'changed' | 'removed'} */ kind) => { plan.pending[kind]++; plan.pendingList.push({ key, kind }); };

  // A file name that repeats (letter case ignored) gets its folder in the prefix.
  /** @type {Map<string, number>} */
  const names = new Map();
  for (const n of o.walk.notes) {
    const base = (n.key.split('/').pop() || '').toLowerCase();
    names.set(base, (names.get(base) || 0) + 1);
  }
  const onDisk = new Set();
  let timeouts = 0;

  for (const file of o.walk.notes) {
    onDisk.add(file.key);
    const fip = (names.get((file.key.split('/').pop() || '').toLowerCase()) || 0) > 1;
    const entry = notes[file.key];
    const spelled = file.file ?? file.key;
    // Bookkeeping only: the note is not read again, and it is not counted as waiting.
    const respell = () => { if (entry && fileOf(file.key, entry) !== spelled) plan.respelled.push({ key: file.key, file: spelled }); };
    const hashed = noteKey(file.key);
    const left = keptLeftOut[hashed];
    if (!o.verify) {
      if (entry && entry.size === file.size && entry.mtimeMs === file.mtimeMs && (o.shallow || !entry.racy) && entry.folderInPrefix === fip) { respell(); plan.unchanged++; plan.eligible++; continue; }
      if (!entry && left && left.size === file.size && left.mtimeMs === file.mtimeMs && (o.shallow || !left.racy)) { leaveOut(file.key, left.reason); plan.leftOutKept[hashed] = left; continue; }
    }
    if (o.shallow && !o.verify) { plan.eligible++; pend(file.key, entry ? 'changed' : 'new'); continue; }

    /** @type {Uint8Array | null} */
    let bytes = null; let current = { size: file.size, mtimeMs: file.mtimeMs }; let problem = null;
    for (let attempt = 0; attempt < 2 && !bytes && !problem; attempt++) {
      try {
        const read = await o.read(file.abs);
        const after = o.stat(file.abs);
        if (!after) { problem = 'unreadable'; break; }
        if (after.size !== current.size || after.mtimeMs !== current.mtimeMs) { current = after; if (attempt === 1) problem = 'changing'; continue; }
        bytes = read;
      } catch (e) {
        problem = /** @type {any} */ (e).code === 'VM_READ_TIMEOUT' ? 'not-downloaded' : 'unreadable';
      }
    }
    if (!bytes) {
      problem = problem || 'changing';
      if (problem === 'not-downloaded') {
        // Its existing passages are kept. It is never treated as removed.
        if (++timeouts >= 3) throw new VmError('VM_E_VAULT_DOWNLOADING');
        leaveOut(file.key, 'not-downloaded');
      } else { plan.skipped.push({ key: file.key, reason: problem }); plan.eligible++; }
      continue;
    }
    const digest = sha256(bytes);
    const racy = Math.abs(now - current.mtimeMs) < 2000;
    if (entry && entry.sha256 === digest && entry.folderInPrefix === fip) {
      plan.eligible++;
      if (entry.size !== current.size || entry.mtimeMs !== current.mtimeMs || entry.racy !== racy) plan.touched.push({ key: file.key, size: current.size, mtimeMs: current.mtimeMs, racy });
      respell();
      plan.unchanged++;
      continue;
    }
    const chunked = o.chunk(bytes, file.key, fip);
    const reason = !chunked.indexable ? 'index-false' : chunked.passages.length === 0 ? 'empty' : null;
    if (reason) {
      leaveOut(file.key, reason);
      plan.leftOutKept[hashed] = racy ? { reason, size: current.size, mtimeMs: current.mtimeMs, racy: true } : { reason, size: current.size, mtimeMs: current.mtimeMs };
      if (entry) { if (o.shallow) pend(file.key, 'removed'); else plan.dropped.push({ key: file.key, reason }); }
      continue;
    }
    plan.eligible++;
    if (o.shallow) { pend(file.key, entry ? 'changed' : 'new'); continue; }
    plan.toEmbed.push({ key: file.key, file: spelled, abs: file.abs, sha256: digest, size: current.size, mtimeMs: current.mtimeMs, racy, folderInPrefix: fip, title: chunked.title, passages: chunked.passages, kind: entry ? 'updated' : 'added' });
    plan.passagesToEmbed += chunked.passages.length;
  }

  for (const lo of o.walk.leftOut) {
    onDisk.add(lo.key);
    leaveOut(lo.key, lo.reason);
    if (!notes[lo.key]) continue;
    if (lo.reason === 'not-downloaded') continue; // keep what the index has
    if (o.shallow) pend(lo.key, 'removed'); else plan.dropped.push({ key: lo.key, reason: lo.reason });
  }

  // A note in the manifest that is absent from a folder that was read without error is removed.
  const unreadable = o.walk.unreadableDirs;
  /** @type {Map<string, string[]>} */
  const goneByHash = new Map();
  for (const key of Object.keys(notes)) {
    if (onDisk.has(key)) continue;
    if (unreadable.some((d) => d === '.' || key.startsWith(d.split('\\').join('/') + '/'))) { plan.skipped.push({ key, reason: 'unreadable' }); continue; }
    plan.removed.push(key);
    const list = goneByHash.get(notes[key].sha256) || [];
    list.push(key); goneByHash.set(notes[key].sha256, list);
  }
  if (o.shallow) {
    for (const key of plan.removed) pend(key, 'removed');
  } else {
    // A new path whose content equals a vanished path's content is a rename.
    for (const n of plan.toEmbed) {
      if (n.kind !== 'added') continue;
      const from = goneByHash.get(n.sha256)?.shift();
      if (from) plan.renamed.push({ from, to: n.key });
    }
  }
  plan.leaving = plan.removed.length - plan.renamed.length + plan.dropped.length;
  if (!o.shallow) {
    // Most recently modified notes first; the largest notes last. A usable index within the first minute.
    plan.toEmbed.sort((a, b) => (Number(a.passages.length > 64) - Number(b.passages.length > 64)) || b.mtimeMs - a.mtimeMs || (a.key < b.key ? -1 : 1));
  }
  return plan;
}

/**
 * The safety stops. Throws with exit 4; nothing has been changed at this point.
 * @param {Plan} plan
 * @param {import('../store/manifest.js').Manifest | null} manifest
 * @param {{ vaultPath: string, allowMassDelete?: boolean }} o
 */
export function safetyStops(plan, manifest, o) {
  const indexed = manifest ? Object.keys(manifest.notes).length : 0;
  if (indexed > 0 && plan.seen === 0) throw new VmError('VM_E_VAULT_EMPTY', { path: o.vaultPath, indexed: indexed.toLocaleString('en-US') });
  if (!o.allowMassDelete && plan.leaving > 10 && plan.leaving > indexed * 0.2) throw new VmError('VM_E_MASS_DELETE', { count: plan.leaving.toLocaleString('en-US') });
}

/**
 * Would a sync started now stop at a safety stop? Asked by status, whose plan never reads a note and
 * so cannot tell a rename from a removal plus an addition: only the removals that no new note could
 * account for are counted, so this never names a stop the sync would not make.
 * @param {Plan} plan    a shallow plan
 * @param {import('../store/manifest.js').Manifest | null} manifest
 * @param {{ vaultPath: string }} o
 * @returns {VmError | null}
 */
export function syncWouldStop(plan, manifest, o) {
  try { safetyStops({ ...plan, leaving: Math.max(0, plan.pending.removed - plan.pending.new) }, manifest, o); return null; } catch (e) {
    if (e instanceof VmError) return e;
    throw e;
  }
}
