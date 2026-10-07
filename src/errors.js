// @ts-check
// Every error a person can meet: one plain sentence, then exactly one next action.

/** @typedef {{ exit: number, message: (p: Record<string, any>) => string, next: (p: Record<string, any>) => string }} ErrorSpec */

/** @type {Record<string, ErrorSpec>} */
export const ERRORS = {
  VM_E_USAGE: { exit: 2, message: (p) => p.detail || 'That command was not understood.', next: () => 'Run `vault-mirror --help`.' },
  VM_E_NO_VAULT: { exit: 2, message: () => 'No vault is set up yet.', next: () => 'Run `vault-mirror init "<path to your vault>"`.' },
  VM_E_NOT_ONE_VAULT: { exit: 2, message: (p) => `${p.path} is not one vault (it is your home folder, a folder of several vaults, or a folder inside a vault).`, next: (p) => p.use ? `Run \`vault-mirror init "${p.use}"\`.` : 'Run `vault-mirror init` with the folder of the one vault you want.' },
  VM_E_OTHER_VAULT: { exit: 2, message: (p) => `This server is set to the vault at ${p.want}, but the vault set up here is ${p.have}.`, next: (p) => `Run \`vault-mirror init "${p.want}"\`, or give each vault its own home folder with \`--home\`.` },
  VM_E_NOT_SYNCED: { exit: 2, message: () => 'Nothing is indexed yet.', next: () => 'Run `vault-mirror sync`.' },
  VM_E_INDEX_IN_VAULT: { exit: 2, message: () => 'The index folder would sit inside your vault. It must stay outside so your notes are never touched.', next: () => 'Remove `VAULT_MIRROR_HOME` or point it to a folder outside the vault.' },
  VM_E_MANIFEST_NEWER: { exit: 2, message: () => 'This index was made by a newer vault-mirror.', next: () => 'Update vault-mirror, or run `vault-mirror rebuild --full`.' },
  VM_E_VAULT_MISSING: { exit: 4, message: (p) => `The vault folder was not found at ${p.path}. Nothing was changed.`, next: () => 'Check the folder still exists there, then run it again.' },
  VM_E_VAULT_EMPTY: { exit: 4, message: (p) => `No notes were found in ${p.path}, but the index has ${p.indexed}. Nothing was changed.`, next: () => 'If the folder is on a cloud drive, let it finish downloading, then run it again.' },
  VM_E_VAULT_DOWNLOADING: { exit: 4, message: () => 'Some notes are still in the cloud and have not downloaded to this computer. Nothing was removed.', next: () => 'Open the vault folder, let it finish downloading, then run `vault-mirror sync`.' },
  VM_E_MASS_DELETE: { exit: 4, message: (p) => `${p.count} notes would leave the index since the last sync. Nothing was changed, in case that is a mistake.`, next: () => 'If that is what you want, run `vault-mirror sync --allow-mass-delete`.' },
  VM_E_NODE_OLD: { exit: 5, message: (p) => `This needs Node 20 or newer. You have ${p.version}.`, next: () => 'Install the current Node from nodejs.org, then run `vault-mirror doctor`.' },
  VM_E_MODEL_OFFLINE: { exit: 5, message: () => 'The reading model is not on this computer yet and the download did not get through.', next: () => 'Connect to the internet and run `vault-mirror doctor`.' },
  VM_E_MODEL_BROKEN: { exit: 5, message: () => 'The reading model file did not finish downloading.', next: (p) => `Delete the folder ${p.path}, then run \`vault-mirror doctor\`.` },
  VM_E_EMBED_FAILING: { exit: 5, message: () => 'Too many notes failed to read into the model, so the sync stopped. What was done is saved.', next: () => 'Run `vault-mirror doctor`.' },
  VM_E_READER: { exit: 5, message: () => 'The reading model stopped before it answered.', next: () => 'Try the search again.' },
  VM_E_DISK_FULL: { exit: 5, message: () => 'The disk is full, so the index could not be saved. Your notes were not touched.', next: () => 'Free about 500 MB, then run `vault-mirror sync`.' },
  VM_E_BUSY: { exit: 6, message: (p) => `Another sync is still running${p.percent != null ? ` (${p.percent}% done)` : ''}. Nothing is wrong.`, next: () => 'Wait for it, or ask "is my vault in sync?"' },
  VM_E_LOCK_LOST: { exit: 6, message: () => 'Another sync took over, so this one stopped. Nothing is wrong.', next: () => 'Ask "is my vault in sync?"' },
  VM_E_INDEX_BUSY: { exit: 6, message: () => 'Another program is using the index right now.', next: () => 'Try again in a moment.' },
  VM_E_STOPPED: { exit: 130, message: (p) => `Stopped at ${p.done} of ${p.total} notes.`, next: () => 'Run it again to continue.' },
  VM_E_INTERNAL: { exit: 1, message: () => 'Something unexpected went wrong. Your notes were not touched.', next: () => 'Run `vault-mirror rebuild`. It is always safe. (If it happens again, `logs/debug.log` holds no note names or text and can be shared.)' },
};

export class VmError extends Error {
  /** @param {string} code @param {Record<string, any>} [params] */
  constructor(code, params = {}) {
    const spec = ERRORS[code] || ERRORS.VM_E_INTERNAL;
    super(spec.message(params));
    this.name = 'VmError';
    this.code = ERRORS[code] ? code : 'VM_E_INTERNAL';
    this.exitCode = spec.exit;
    this.next = spec.next(params);
    this.params = params;
  }
}

/** Turn anything thrown into a VmError. Disk-full is recognised; the rest is internal. @param {any} e */
export function toVmError(e) {
  if (e instanceof VmError) return e;
  if (e && e.code === 'ENOSPC') return new VmError('VM_E_DISK_FULL');
  const wrapped = new VmError('VM_E_INTERNAL');
  wrapped.cause = e;
  return wrapped;
}
