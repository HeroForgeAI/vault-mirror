// @ts-check
// Version numbers in one place.
export const TOOL_NAME = 'vault-mirror';
export const TOOL_VERSION = '0.1.1';
/** Any change to chunker output bumps this, and every note is re-read once. */
export const CHUNKER_VERSION = 1;
export const SCHEMA = 1;
/** The versions this release was tested with. doctor warns when a loaded one differs. */
export const PINS = { ruvector: '0.3.3', core: '0.1.32', native: '0.1.30' };
