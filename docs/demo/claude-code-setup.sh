#!/usr/bin/env bash
# Builds the throwaway sandbox that docs/demo/claude-code.tape records in.
#
#   bash docs/demo/claude-code-setup.sh   # from the repo root, after `npm ci`
#   vhs docs/demo/claude-code.tape        # then the one ffmpeg line at the top of the tape
#
# The sandbox is a pretend home folder (default /tmp/you) that holds:
#   garden-notes/     a copy of the invented vault in tests/fixtures/vault, without its edge-case folders
#   garden-project/   the folder Claude Code is opened in. `vault-mirror init` writes the vault rule
#                     into its CLAUDE.md, and .claude/settings.json lets `vault-mirror search` run without a prompt
#   .vault-mirror/    the index (set VAULT_MIRROR_HOME before running this to put it somewhere else)
#   bin/vault-mirror  runs this checkout's tool with the pretend home, so paths on screen are the sandbox's
# Claude Code itself runs as you, signed in as you; the tape keeps your own settings out of the session.
# It also lists garden-notes in a pretend copy of Obsidian's vault list, so results carry obsidian:// links.
# Nothing in your real vault or real index is read or written. Delete the folder when you are done.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd -P)"
DEMO="${VM_DEMO_HOME:-/tmp/you}"
REAL_HOME="$HOME"

rm -rf "$DEMO"
mkdir -p "$DEMO/bin" "$DEMO/zdot" "$DEMO/garden-project/.claude" "$DEMO/Library/Application Support/obsidian" "$DEMO/.config/obsidian"
DEMO="$(cd "$DEMO" && pwd -P)"   # on macOS /tmp is a link to /private/tmp
INDEX="${VAULT_MIRROR_HOME:-$DEMO/.vault-mirror}"

cp -R "$REPO/tests/fixtures/vault" "$DEMO/garden-notes"
rm -rf "$DEMO/garden-notes/Edge" "$DEMO/garden-notes/Journal" "$DEMO/garden-notes/Hidden by Obsidian"

printf '#!/bin/sh\nHOME="%s" VAULT_MIRROR_HOME="%s" exec node "%s/bin/vault-mirror.js" "$@"\n' "$DEMO" "$INDEX" "$REPO" > "$DEMO/bin/vault-mirror"
chmod +x "$DEMO/bin/vault-mirror"

# Reuse the reading model if this computer already has it, so setup does not download it again.
if [ -d "$REAL_HOME/.ruvector" ]; then ln -s "$REAL_HOME/.ruvector" "$DEMO/.ruvector"; fi

LIST="{\"vaults\":{\"a1b2c3d4e5f60718\":{\"path\":\"$DEMO/garden-notes\",\"ts\":1790000000000}}}"
printf '%s\n' "$LIST" > "$DEMO/Library/Application Support/obsidian/obsidian.json"   # macOS
printf '%s\n' "$LIST" > "$DEMO/.config/obsidian/obsidian.json"                        # Linux

# The one thing Claude Code may run without asking. It may not edit or write files.
printf '{\n  "permissions": { "allow": ["Bash(vault-mirror search:*)"], "deny": ["Edit", "Write", "NotebookEdit"] }\n}\n' > "$DEMO/garden-project/.claude/settings.json"

cd "$DEMO/garden-project"
"$DEMO/bin/vault-mirror" init "$DEMO/garden-notes"
"$DEMO/bin/vault-mirror" sync
echo
echo "Sandbox ready at $DEMO. Now run: vhs docs/demo/claude-code.tape"
