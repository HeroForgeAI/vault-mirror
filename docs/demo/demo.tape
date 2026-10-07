# The README demo. A real run, at real speed, on an invented vault.
#
#   bash docs/demo/setup.sh    # builds the sandbox in /tmp/vm and runs `vault-mirror init`
#   vhs docs/demo/demo.tape    # from the repo root; writes docs/demo/demo.gif
#
# The vault is the invented one in tests/fixtures/vault without its edge-case folders,
# copied under the name garden-notes by setup.sh.
# The window is narrow so the text can be read on a phone. Two things are set up off screen,
# in the hidden lines below: the prompt, and a wrapper that passes what the tool prints
# through docs/demo/wrap.awk, so long lines break at a space and not in the middle of a word.
# Every character shown is what the tool prints; only those line breaks are added.
# Because the output goes through a pipe, each progress line stays on screen
# (in a terminal the tool redraws one line).
# Run setup.sh again before each recording: the recording edits the copied note.
# On Linux change /private/tmp to /tmp in the line marked below.

Output docs/demo/demo.gif

Set Shell zsh
Set FontSize 24
Set Width 880
Set Height 680
Set Padding 14
Set WindowBar Colorful
Set TypingSpeed 14ms
Set CursorBlink false
Set Theme { "name": "vault-mirror", "background": "#161b22", "foreground": "#e6edf3", "cursor": "#ab7df8", "selection": "#3d444d", "black": "#484f58", "red": "#ff7b72", "green": "#3fb950", "yellow": "#d29922", "blue": "#58a6ff", "magenta": "#ab7df8", "cyan": "#39c5cf", "white": "#b1bac4", "brightBlack": "#8b949e", "brightRed": "#ffa198", "brightGreen": "#56d364", "brightYellow": "#e3b341", "brightBlue": "#79c0ff", "brightMagenta": "#d2a8ff", "brightCyan": "#56d4dd", "brightWhite": "#f0f6fc" }

# macOS path of the sandbox (Linux: /tmp/vm)
Env HOME "/private/tmp/vm"

Hide
Type "export PATH=$HOME/bin:$PATH PROMPT='%F{magenta}$%f ' PROMPT2='  '; setopt interactivecomments" Enter
Type 'vault-mirror() { command vault-mirror "$@" 2>&1 | awk -v w=54 -f ~/bin/wrap.awk }' Enter
Type "cd ~/my-project && clear" Enter
Type "vault-mirror sync"
Show

# 1. The first sync reads every note once and ends with the 1:1 line.
Sleep 300ms
Enter
Wait+Screen@20s /added 15/
Sleep 3.2s

# 2. A question in words the note does not use. The note says "a dark patch on the base of the fruit".
Hide
Type "clear" Enter
Type 'vault-mirror search \' Enter
Type '  "why is the fruit going black underneath" -k 1'
Show
Sleep 500ms
Enter
Wait+Screen@10s /match/
Sleep 3.6s

# 3. The person edits a note. The tool never does: it only reads.
Type "# You add a section to a note, in any editor:" Enter
Type 'echo "## Pruning" \' Enter
Type "  >> ~/garden-notes/Garden/Tomatoes.md" Enter
Type 'echo "Pinch out the side shoots every week." \' Enter
Type "  >> ~/garden-notes/Garden/Tomatoes.md" Sleep 300ms Enter
Sleep 1.4s

# 4. The next sync reads only the note that changed.
Hide
Type "clear" Enter
Type "vault-mirror sync"
Show
Sleep 500ms
Enter
Wait+Screen@20s /updated 1/
Sleep 1.8s

# 5. The new section is found.
Type 'vault-mirror search \' Enter
Type '  "when should I pinch out shoots" -k 1' Sleep 300ms Enter
Wait+Screen@10s /match 0/
Sleep 4.5s
