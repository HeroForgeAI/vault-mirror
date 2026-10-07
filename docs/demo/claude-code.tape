# The second README demo: the same search, asked in plain English inside Claude Code.
# A real session, at real speed, on the invented vault. Nothing is replayed or typed in afterwards.
#
#   bash docs/demo/claude-code-setup.sh   # builds the sandbox in /tmp/you, runs `vault-mirror init` and `sync`
#   vhs docs/demo/claude-code.tape        # from the repo root; writes docs/demo/claude-code-raw.gif
#   ffmpeg -i docs/demo/claude-code-raw.gif -filter_complex \
#     "crop=880:CROP_H:0:CROP_Y,pad=880:ih+14:0:14:color=0x161b22,tpad=stop_mode=clone:stop_duration=2,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none" \
#     docs/demo/claude-code.gif && rm docs/demo/claude-code-raw.gif
#
# You need Claude Code installed and signed in. The session uses your account, so the answer's
# wording differs a little from run to run; check it against the note before you keep a recording.
# The window is recorded tall so nothing scrolls, and the ffmpeg line then cuts it down to the
# conversation: it removes the start-up banner above the typed ask (it names the account's plan and
# shows account notices) and the empty space below. CROP_Y is the first pixel row under the banner
# and CROP_H the height down to the footer; they depend on how tall the banner is that day
# (the committed recording used CROP_Y=290 and CROP_H=730). It also holds the last frame for two more
# seconds. Nothing inside the kept area is changed.
# Off screen, in the hidden lines below: the prompt, a clean environment, the folder, and starting
# `claude` with only the project's own settings (--setting-sources project), no MCP servers and
# asking before anything not on the allow list (--permission-mode manual). The Down and Enter answer
# the "do you trust this folder" question the first time the folder is opened.
# On Linux change /private/tmp to /tmp in the lines marked below.

Output docs/demo/claude-code-raw.gif

Set Shell zsh
Set FontSize 24
Set Width 880
Set Height 1400
Set Padding 14
Set TypingSpeed 45ms
Set CursorBlink false
Set Theme { "name": "vault-mirror", "background": "#161b22", "foreground": "#e6edf3", "cursor": "#ab7df8", "selection": "#3d444d", "black": "#484f58", "red": "#ff7b72", "green": "#3fb950", "yellow": "#d29922", "blue": "#58a6ff", "magenta": "#ab7df8", "cyan": "#39c5cf", "white": "#b1bac4", "brightBlack": "#8b949e", "brightRed": "#ffa198", "brightGreen": "#56d364", "brightYellow": "#e3b341", "brightBlue": "#79c0ff", "brightMagenta": "#d2a8ff", "brightCyan": "#56d4dd", "brightWhite": "#f0f6fc" }

# macOS path of the sandbox (Linux: /tmp/you/zdot). An empty folder, so your own shell setup is not loaded.
Env ZDOTDIR "/private/tmp/you/zdot"
Env DISABLE_AUTOUPDATER "1"

Hide
Type "for v in $(env | grep -o '^CLAUDE[A-Z_]*'); do unset $v; done" Enter
# macOS paths of the sandbox (Linux: /tmp/you)
Type "export PATH=/private/tmp/you/bin:$PATH PROMPT='$ '" Enter
Type "cd /private/tmp/you/garden-project && clear" Enter
Type "claude --setting-sources project --strict-mcp-config --permission-mode manual --model sonnet" Enter
Sleep 7s
Down
Sleep 300ms
Enter
Sleep 4s
Show

# The ask, in plain English. Claude Code runs the search itself: the vault rule in CLAUDE.md tells it how.
Sleep 800ms
Type "Use vault-mirror to search my vault: why is the fruit going black underneath? Keep it short and name the note."
Sleep 700ms
Enter
Wait+Screen@60s /for \d+s/
Sleep 5s

Hide
Type "/exit" Enter
Sleep 1s
