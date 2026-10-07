# The README demo. A real run, at real speed, on an invented vault.
#
#   bash docs/demo/setup.sh    # builds the sandbox in /tmp/vm-demo and runs `vault-mirror init`
#   vhs docs/demo/demo.tape    # from the repo root; writes docs/demo/demo.gif
#
# The vault is the invented one in tests/fixtures/vault, copied under the name garden-notes.
# Nothing is hidden but the shell setup: every line of output is what the tool prints,
# wrapped by the terminal itself at this window's width.
# Run setup.sh again before each recording: the recording edits the copied note.
# On Linux change /private/tmp to /tmp in the line marked below.

Output docs/demo/demo.gif

Set Shell zsh
Set FontSize 22
Set Width 1200
Set Height 580
Set Padding 28
Set WindowBar Colorful
Set TypingSpeed 14ms
Set CursorBlink false
Set Theme { "name": "vault-mirror", "background": "#161b22", "foreground": "#e6edf3", "cursor": "#ab7df8", "selection": "#3d444d", "black": "#484f58", "red": "#ff7b72", "green": "#3fb950", "yellow": "#d29922", "blue": "#58a6ff", "magenta": "#ab7df8", "cyan": "#39c5cf", "white": "#b1bac4", "brightBlack": "#8b949e", "brightRed": "#ffa198", "brightGreen": "#56d364", "brightYellow": "#e3b341", "brightBlue": "#79c0ff", "brightMagenta": "#d2a8ff", "brightCyan": "#56d4dd", "brightWhite": "#f0f6fc" }

# macOS path of the sandbox (Linux: /tmp/vm-demo)
Env HOME "/private/tmp/vm-demo"

Hide
Type "export PATH=$HOME/bin:$PATH PROMPT='%F{magenta}$%f '; setopt interactivecomments" Enter
Type "cd ~/my-project && clear" Enter
Type "vault-mirror sync"
Show

# 1. The first sync reads every note once and ends with the 1:1 line.
Sleep 700ms
Enter
Wait+Screen@20s /added 15/
Sleep 1.6s

# 2. A question in words the note does not use. The note says "a dark patch on the base of the fruit".
Type 'vault-mirror search "why is the fruit going black underneath" -k 1' Sleep 300ms Enter
Wait+Screen@10s /match/
Sleep 4.2s

Hide
Type "clear" Enter
Show

# 3. The person edits a note. The tool never does: it only reads.
Type "# You add a section to a note, in Obsidian or any editor:" Enter
Type "printf '\n## Pruning\n\nPinch out the side shoots every week.\n' \" Enter
Type "  >> ~/garden-notes/Garden/Tomatoes.md" Sleep 300ms Enter
Sleep 600ms

# 4. The next sync reads only the note that changed.
Type "vault-mirror sync" Sleep 300ms Enter
Wait+Screen@20s /updated 1/
Sleep 1.8s

# 5. The new section is found.
Type 'vault-mirror search "when should I pinch out shoots" -k 1' Sleep 300ms Enter
Wait+Screen@10s /Pruning/
Sleep 4.5s
