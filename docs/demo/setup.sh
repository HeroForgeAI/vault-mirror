#!/usr/bin/env bash
# Builds the throwaway sandbox that docs/demo/demo.tape records in.
#
#   bash docs/demo/setup.sh     # from the repo root, after `npm ci`
#   vhs docs/demo/demo.tape     # writes docs/demo/demo.gif
#
# The sandbox is a pretend home folder (default /tmp/vm) that holds:
#   garden-notes/   a copy of the invented vault in tests/fixtures/vault, without its edge-case folders
#   .vault-mirror/  the index the recording makes (the tool's default place, under the pretend home)
#   bin/            a link to this checkout's vault-mirror, and the recording's line wrapper
# It also lists garden-notes in a pretend copy of Obsidian's vault list, so results carry
# obsidian:// links the way they do once Obsidian has opened a folder as a vault.
# Nothing outside the sandbox is written. Delete the folder when you are done.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd -P)"
DEMO="${VM_DEMO_HOME:-/tmp/vm}"
REAL_HOME="$HOME"

rm -rf "$DEMO"
mkdir -p "$DEMO/bin" "$DEMO/my-project" "$DEMO/Library/Application Support/obsidian" "$DEMO/.config/obsidian"
DEMO="$(cd "$DEMO" && pwd -P)"   # on macOS /tmp is a link to /private/tmp

cp -R "$REPO/tests/fixtures/vault" "$DEMO/garden-notes"
rm -rf "$DEMO/garden-notes/Edge" "$DEMO/garden-notes/Journal" "$DEMO/garden-notes/Hidden by Obsidian"
ln -s "$REPO/bin/vault-mirror.js" "$DEMO/bin/vault-mirror"
cp "$REPO/docs/demo/wrap.awk" "$DEMO/bin/wrap.awk"   # the recording's line wrapper

# Reuse the reading model if this computer already has it, so the recording does not download it again.
if [ -d "$REAL_HOME/.ruvector" ]; then ln -s "$REAL_HOME/.ruvector" "$DEMO/.ruvector"; fi

LIST="{\"vaults\":{\"a1b2c3d4e5f60718\":{\"path\":\"$DEMO/garden-notes\",\"ts\":1790000000000}}}"
printf '%s\n' "$LIST" > "$DEMO/Library/Application Support/obsidian/obsidian.json"   # macOS
printf '%s\n' "$LIST" > "$DEMO/.config/obsidian/obsidian.json"                        # Linux

cd "$DEMO/my-project"
HOME="$DEMO" "$DEMO/bin/vault-mirror" init "$DEMO/garden-notes"
echo
echo "Sandbox ready at $DEMO. Now run: vhs docs/demo/demo.tape"
