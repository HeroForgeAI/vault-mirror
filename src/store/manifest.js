// @ts-check
// manifest.json: the kept state. A snapshot, rewritten atomically at every checkpoint.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic, ensureDir } from './safe-write.js';
import { VmError } from '../errors.js';
import { SCHEMA, TOOL_NAME, TOOL_VERSION } from '../version.js';

/**
 * @typedef {object} NoteEntry
 * @property {string} sha256
 * @property {number} size
 * @property {number} mtimeMs
 * @property {boolean} racy
 * @property {number} passages
 * @property {boolean} folderInPrefix
 * @property {[number, number]} log   byte offset and length of the note's record in passages.jsonl
 * @property {number} vec             position of the note's first vector in vectors.f32
 * @property {number} flagged
 * @property {string} [file]         the vault-relative path as spelled on disk, kept only when it differs from the key
 *
 * @typedef {object} Manifest
 * @property {number} schema
 * @property {string} stamp
 * @property {{ name: string, version: string }} tool
 * @property {{ name: string, path: string, pathHash: string }} vault
 * @property {{ version: number, settingsHash: string, budgetTokens: number, counter: string }} chunker
 * @property {Record<string, any>} embedding
 * @property {Record<string, any>} engine
 * @property {{ logBytes: number, vectors: number, deadRecords: number }} sidecar
 * @property {{ notes: number, passages: number }} totals
 * @property {{ at: string, seconds: number, complete: boolean, counts: Record<string, number> } | null} lastRun
 * @property {Record<string, NoteEntry>} notes
 * @property {Record<string, { reason: string, size: number, mtimeMs: number, racy?: boolean }>} leftOut
 */

/**
 * A note's vault-relative path as it is spelled on disk. The key is one spelling for every form of a
 * name (NFC, ordinary spaces); a disk that tells the forms apart opens the file by this one only.
 * @param {string} key @param {{ file?: string } | undefined} entry
 */
export function fileOf(key, entry) {
  return entry?.file ?? key;
}

/** The live data folder's name, or null when nothing has been saved yet. @param {string} indexDir */
export function currentDataName(indexDir) {
  try {
    const name = fs.readFileSync(path.join(indexDir, 'CURRENT'), 'utf8').trim();
    return /^data-\d{4,}$/.test(name) ? name : null;
  } catch { return null; }
}

/** @param {string | null} name */
export function nextDataName(name) {
  const n = name ? Number(name.slice(5)) + 1 : 1;
  return `data-${String(n).padStart(4, '0')}`;
}

/** Point CURRENT at a data folder with one atomic rename. @param {string} indexDir @param {string} dataName */
export function switchCurrent(indexDir, dataName) {
  writeFileAtomic(path.join(indexDir, 'CURRENT'), dataName + '\n');
}

/**
 * Read the manifest of the live data folder. A reader whose folder vanishes mid-read
 * (a tidy rewrite just switched) re-reads CURRENT and retries once.
 * @param {string} indexDir
 * @returns {{ manifest: Manifest, dataName: string, dataDir: string } | null}
 */
export function loadManifest(indexDir) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const dataName = currentDataName(indexDir);
    if (!dataName) return null;
    const dataDir = path.join(indexDir, dataName);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dataDir, 'manifest.json'), 'utf8'));
      if (typeof manifest.schema !== 'number' || manifest.schema > SCHEMA) throw new VmError('VM_E_MANIFEST_NEWER');
      return { manifest, dataName, dataDir };
    } catch (e) {
      if (e instanceof VmError) throw e;
      if (attempt === 1) return null;
    }
  }
  return null;
}

/**
 * Run a reader's work against the live data folder. When that folder vanishes mid-read (a sync's
 * tidy rewrite switched CURRENT and removed it), re-read CURRENT and run the work once more.
 * @template T
 * @param {string} indexDir
 * @param {{ manifest: Manifest, dataDir: string }} loaded
 * @param {(loaded: { manifest: Manifest, dataDir: string }) => T | Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withLiveData(indexDir, loaded, work) {
  try { return await work(loaded); } catch (e) {
    const fresh = /** @type {any} */ (e)?.code === 'ENOENT' ? loadManifest(indexDir) : null;
    if (!fresh || fresh.dataDir === loaded.dataDir) throw e;
    return work(fresh);
  }
}

/**
 * @param {{ dataName: string, vault: Manifest['vault'], chunker: Manifest['chunker'], embedding: Record<string, any>, engine: Record<string, any> }} o
 * @returns {Manifest}
 */
export function newManifest(o) {
  return {
    schema: SCHEMA,
    stamp: `${o.dataName}:0`,
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    vault: o.vault,
    chunker: o.chunker,
    embedding: o.embedding,
    engine: o.engine,
    sidecar: { logBytes: 0, vectors: 0, deadRecords: 0 },
    totals: { notes: 0, passages: 0 },
    lastRun: null,
    notes: {},
    leftOut: {},
  };
}

/** Recount totals from the notes. @param {Manifest} manifest */
export function retotal(manifest) {
  let passages = 0; let notes = 0;
  for (const key in manifest.notes) { notes++; passages += manifest.notes[key].passages; }
  manifest.totals = { notes, passages };
}

/**
 * Save the manifest atomically. The stamp counter goes up whenever the set of passages changed;
 * a bookkeeping-only write (a new date on an unchanged note, the last-run line) keeps the stamp,
 * so it does not force the engine to reload.
 * @param {string} dataDir @param {Manifest} manifest @param {boolean} [contentChanged]
 */
export function saveManifest(dataDir, manifest, contentChanged = true) {
  const [name, counter] = manifest.stamp.split(':');
  if (contentChanged) manifest.stamp = `${name}:${Number(counter) + 1}`;
  manifest.tool = { name: TOOL_NAME, version: TOOL_VERSION };
  retotal(manifest);
  ensureDir(dataDir);
  writeFileAtomic(path.join(dataDir, 'manifest.json'), JSON.stringify(manifest));
}
