// @ts-check
// config.json: one current vault and its settings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { expandHome, tildify } from './paths.js';
import { writeFileAtomic, ensureDir } from '../store/safe-write.js';
import { SCHEMA } from '../version.js';
import { DEFAULT_MODEL } from '../embed/models.js';

export const VAULT_DEFAULTS = Object.freeze({
  exclude: /** @type {string[]} */ ([]),
  minWords: 3,
  dropFences: ['mermaid', 'dataview', 'dataviewjs', 'query', 'base', 'tasks'],
  screen: 'report',
  workers: /** @type {'auto' | number} */ ('auto'),
  obsidianExcludes: true,
  searchAutoSyncMaxPassages: 20,
  resultCount: 8,
  readingSummary: /** @type {boolean} */ (true),
});

/** The folder everything is written under. */
export function homeDir() {
  const env = process.env.VAULT_MIRROR_HOME;
  return env ? expandHome(env) : path.join(os.homedir(), '.vault-mirror');
}

/** @param {string} home */
export function configPath(home) { return path.join(home, 'config.json'); }

/**
 * @param {string} home
 * @returns {{ schema: number, vault: (typeof VAULT_DEFAULTS & { path: string }) | null, embedding: { model: string } }}
 */
export function loadConfig(home) {
  /** @type {any} */
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(configPath(home), 'utf8')); } catch (e) {
    if (/** @type {any} */ (e).code !== 'ENOENT') raw = {};
  }
  const vault = raw.vault && typeof raw.vault.path === 'string'
    ? { ...VAULT_DEFAULTS, ...raw.vault, path: expandHome(raw.vault.path) }
    : null;
  return { schema: SCHEMA, vault, embedding: { model: raw.embedding?.model || DEFAULT_MODEL } };
}

/** @param {string} home @param {ReturnType<typeof loadConfig>} cfg */
export function saveConfig(home, cfg) {
  ensureDir(home);
  const out = { schema: SCHEMA, vault: cfg.vault ? { ...cfg.vault, path: tildify(cfg.vault.path) } : null, embedding: cfg.embedding };
  writeFileAtomic(configPath(home), JSON.stringify(out, null, 2) + '\n');
}

/** The index folder for one vault: a safe name plus 8 hex of its real path. @param {string} home @param {string} vaultReal */
export function indexDirFor(home, vaultReal) {
  const safe = path.basename(vaultReal).replace(/[^A-Za-z0-9._-]/g, '_') || 'vault';
  const hash = crypto.createHash('sha256').update(vaultReal).digest('hex').slice(0, 8);
  return path.join(home, 'indexes', `${safe}-${hash}`);
}

/**
 * The worker count for a first sync: automatic and conservative.
 * @param {'auto' | number} setting
 * @param {{ cores?: number, totalGB?: number }} [machine]
 * @returns {{ workers: number, note: string | null }}
 */
export function chooseWorkers(setting, machine = {}) {
  const cores = machine.cores ?? os.availableParallelism();
  const totalGB = machine.totalGB ?? os.totalmem() / 2 ** 30;
  if (typeof setting === 'number' && Number.isFinite(setting)) {
    const n = Math.max(0, Math.min(8, Math.floor(setting)));
    return { workers: n, note: n > 4 ? `Using ${n} readers. Your computer will be busy while this runs.` : null };
  }
  if (totalGB < 7.5 || cores <= 2) return { workers: 0, note: null };
  return { workers: Math.max(0, Math.min(4, Math.floor(cores / 2), Math.floor((totalGB + 0.5) / 4))), note: null };
}
