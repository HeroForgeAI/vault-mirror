// @ts-check
// Which vault a server serves. It is found the way every command finds it, so the server works from
// any folder: the settings file in the home folder (`~/.vault-mirror`, or `VAULT_MIRROR_HOME`, or this
// server's `--home`) names the one vault that `init` set up. It is read again on every call, so a
// vault set up after the server started is found without a restart.
import path from 'node:path';
import { loadContext } from '../cli/context.js';
import { expandHome, resolveSafe } from '../config/paths.js';
import { setLogDir } from '../log.js';
import { VmError } from '../errors.js';

/**
 * @param {{ vault?: string | null }} [pin]   `--vault`: the one vault this server may serve
 * @returns {import('../sync/run.js').Context}
 */
export function locate(pin = {}) {
  const ctx = loadContext({ needVault: true });
  if (pin.vault) {
    // A server added as "work notes" must never start answering from another vault because `init` was run again.
    let want = expandHome(pin.vault);
    try { want = resolveSafe(want); } catch { /* compared as written */ }
    if (want !== ctx.vault.real) throw new VmError('VM_E_OTHER_VAULT', { want, have: ctx.vault.real });
  }
  setLogDir(path.join(ctx.indexDir, 'logs'));
  return ctx;
}
