# Changelog

All notable changes to vault-mirror are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A change to how notes are cut into passages, or to the reading model, makes every note re-read once on the next sync. Such a change is always called out under **Changed**.

## [Unreleased]

### Added

- An MCP server: `vault-mirror mcp`, over stdio, on the official MCP SDK. Add it to an app once and its AI can search your vault with a named tool from any project, with no rule line per project and no shell command to approve. Three tools: `search_vault` (structured results: note, heading, file, line, score and `obsidian://` link for each passage, plus the exact-words list), `vault_status` (is the index in step with the vault) and `sync_index` (brings the index up to date; it writes only to vault-mirror's own index folder). **The server has no tool that writes to a vault**, and a call that tries to pass a path is refused. A unit test lists the tools and checks that; an end-to-end test checksums the fixture vault before and after every tool has run, under the same write spy the commands are tested with.
- The server keeps the reading model loaded between searches, in a helper process that starts with the first search and stops after five minutes without one (`--idle-minutes` changes that). A repeat search skips loading the model. The helper takes about 0.6 GB while it is alive. The server itself never opens the index file and holds no lock, so `sync` and `search` in a terminal are never kept waiting by it.
- `vault-mirror mcp --setup` prints the lines that add the server to Claude Code, Codex and Claude Desktop, with full paths. It changes no file.
- `vault-mirror mcp --home <folder>` and `--vault <folder>`: which settings a server reads, and a pin that makes a server refuse to answer from any other vault. Two vaults in one app are two entries, each with its own home folder.
- `docs/MCP.md`: what the server is, setup for each app, the tools, what it can and cannot do, and troubleshooting.
- A second runtime dependency, pinned exactly: `@modelcontextprotocol/server` 2.3.1. Only `vault-mirror mcp` loads it.
- `search` ends with one line that says how much text came back and how much the notes it came from hold, for example "Returned about 590 words in 5 passages, from 5 notes that hold about 9,200 words." It counts words, not tokens, from records the search has already read, and works out no multiplier. The line goes to stderr with the other notices, so the result lists on stdout are unchanged. `--json` carries the same counts as `reading: { passages, words, notes, noteWords }`. `--quiet`, or `"readingSummary": false` in the settings, turns the line off.
- `docs/GETTING-NOTES-IN.md`: how to turn emails, PDFs, Word files and Notion pages into Markdown notes the tool can read, and what to keep out. Linked from the README.

### Changed

- The rule that `init` writes has one more sentence: use `vault-mirror search` before the Obsidian command-line tool or plain file search, and turn to those only when it returns nothing useful. Run `vault-mirror init "<folder>"` again to get it. `init` replaces the earlier rule where it stands, also when it was pasted without its two markers, touches no other line, and keeps the file's line endings.

### Fixed

- Times that round up to a whole minute or hour now read that way: 59.5 seconds is `1 min` and 3599.5 seconds is `1 h 0 min`, not `60 s` or `59 min 60 s`.
- `--workers` now takes `auto` or a whole number only, on `sync` and `rebuild` alike. A fraction, an empty value and forms such as `0x10` or `1e3` used to slip through and are now refused with the same sentence; `rebuild --workers abc` without `--full` is refused too. Builds on the fix GreedyC contributed in [#18](https://github.com/HeroForgeAI/vault-mirror/pull/18).

## [0.1.1] - 2026-10-08

vault-mirror now works on Windows and Linux as it does on a Mac. Notes are still only ever read. Upgrading reads no note again: nothing changed in how notes are cut or read, and an index made by 0.1.0 is kept.

### Fixed

- Windows and Linux: the file path in a search result now opens for a note whose name holds an accent stored as a plain letter plus a separate accent mark (the usual form for names made on a Mac, kept when a vault is copied or synced to another system), or a no-break space. The index knows every note by one spelling of its name, and the path was built from that spelling; a Mac opens either spelling, Windows and Linux open only the one on disk. The name as the disk spells it is now kept beside it and used for the path. Such a note was always indexed and found, with its full text; only the path was wrong. No note is read again: the next `sync`, or the quick sync a `search` runs first, adds the name to an existing index. Until then a `search --no-sync` on an index made by 0.1.0 still shows the old path for such a note.
- `init` on a disk that tells letter case apart (most Linux disks): the templates folder that Obsidian's own setting names is now left out when the setting spells it in another letter case, as every other `exclude` entry already was.
- `sync` on a computer with one reader (under 8 GB of memory, or two cores): Ctrl+C now stops it at the next passage. Before, it was not noticed until the sync had finished.
- The first-run download: time when the computer was asleep or the process was held up is no longer counted as "no data arriving", so a slow download is not given up on by mistake.
- Windows: the fast engine is now used. The check that a new index is the exact kind read the index file while the engine had it open, which Windows does not allow, so every command fell back to the built-in exact search and `doctor` reported "A test index could not be created". The file is now created by a short helper process and read before it is opened. Searches on 0.1.0 were still correct; they used the slower built-in search.
- `sync --detach` on Windows no longer opens a console window of its own.
- `init`: a `CLAUDE.md` or `AGENTS.md` whose lines end the Windows way (CRLF) now gets the rule in that form. Before, the rule was added with plain line endings and the file ended up with both kinds.
- `rebuild --full` rejects invalid `--workers` values with the same usage error as `sync`, before starting to re-read notes.

### Added

- Regression tests for hour-long durations, exact minutes and the short-wait ETA rounding and five-second floor.

### Changed

- Tests and CI only: the unit tests no longer assume a Mac (typed POSIX paths, Windows short folder names, a signal Windows cannot send, line endings), and the end-to-end acceptance script now also runs on Linux and Windows runners. A new first-run job installs with the README's line on all three systems and Node 20, 22 and 24 (on Windows from PowerShell and from the command prompt, checking the command's exit codes in each), and runs the first commands on a small invented vault: a path with spaces and parentheses inside a OneDrive-style folder, names with accents, Japanese and an emoji, a rename in letter case only, a path of about 500 characters, a note held by another program, and a full rebuild. A failure of the unit tests or the first run on any of the three systems now fails CI. A `.gitattributes` rule keeps text files LF on every system.
- The index's `manifest.json` may hold one new optional field per note, `file`: the note's name as the disk spells it, written only when it differs from the name the index uses. 0.1.0 ignores it, so going back to 0.1.0 needs no rebuild.
- README: says who builds and maintains the project (Mak Allen of the HeroForge.AI team) and where to find him on X.
- Documentation only: a new README first screen with a picture of a real result, a "Set it up" section with steps for a person, steps for an AI and four commands to type by hand, a new demo recording, and a labelled figure of what a search returns. Long reference material moved to `docs/FIRST-RUN.md`, `docs/HOW-IT-WORKS.md` and `docs/COMPARISON.md`. The README now names `~/.ruvector/models/`, where the ruvector library keeps the reading model, in the safety facts and the removal steps. Recall counts are no longer printed in the README; they are in `docs/BENCHMARKS.md`.

### Known limits

- Tested on macOS (Apple Silicon), Windows (x64) and Linux (x64), on GitHub's hosted machines. Intel Macs, Windows on ARM, Linux on ARM, musl Linux (Alpine), WSL and containers are not yet verified.
- The largest vault run on Windows and Linux has about 170 notes.
- A note written entirely in a language without spaces between words (for example Japanese) is counted as empty and left out, on every system. `status --list` names it.
- Windows: one program cannot send Ctrl+C to another, so the acceptance step for Ctrl+C in the middle of a sync is skipped there. A forced stop in the middle of a sync is tested.
- Windows, not observable on CI: whether `sync --detach` shows a console window on a desktop, and notes that OneDrive shows but has not downloaded.
- An `obsidian://` link carries the one spelling of a note's name. Whether Obsidian on Windows or Linux opens a note whose name on disk holds a separate accent mark from such a link has not been confirmed by a person. The file path in the same result opens it.
- The known limits of 0.1.0 below still hold, except its first line.

## [0.1.0] - 2026-10-07

The first release.

### Added

- `init`: sets the one current vault and writes a one-line rule for your AI into `CLAUDE.md` and `AGENTS.md`.
- `sync`: brings the index in step with the vault. Only changed notes are read (size and date first, then a SHA-256 fingerprint). Edits replace, renames move, deletes remove. It resumes after an interruption, queues behind another sync, and `--detach` runs it in the background.
- `search`: one call returns two lists, by meaning and by exact words. Several wordings can be passed in one call. Every result carries the note, heading trail, file path, line, an `obsidian://` link and the full passage.
- `status`: the 1:1 proof, as nine named checks. `--verify` fingerprints every note and checks every passage in the engine; `--list` and `--screen` name what is left out or flagged.
- `rebuild`: rebuilds the index from saved passages without re-reading a note. `--full` re-reads everything.
- `doctor`: checks Node, the engine, the pinned versions, the model, the disk and the vault, and ends with one next step, or says the vault is in step.
- The read-only guarantee: one module may read vault paths and has no write call; one module may write and refuses any path inside a vault. Tested by before-and-after checksum listings, a read-only vault on disk, a write spy and a static scan.
- A safety screen that flags passages that look like they hold a key or password and masks them in results.
- `--json` on every command: one object, a stable shape, plain error codes with one next action each.
- Leaving notes out: `exclude` folders, `index: false` in a note's properties, and Obsidian's own "Excluded files" setting.
- Contribution and governance docs: `CONTRIBUTING.md` (pull requests from a fork, approved by a maintainer, and the hard lines no change may cross), `GOVERNANCE.md`, `.github/CODEOWNERS`, a pull request checklist and a question form.

### Fixed before the tag

- The exact-words table kept a note's old word rows when the note was cut again without its content changing. This happens when a second note with the same file name appears or goes: the folder then joins or leaves what the first note's passages are read with, and its cuts can move. Plain `status` still passed; only `status --verify` saw it. The table's per-note key now also carries that flag, so the note's rows are made again. A table written by an earlier build is made again once, by the next search, status or sync. Covered by a unit test and acceptance step X2.

- An `exclude` entry that matched no folder was accepted in silence, and `status` then named that folder as left out while its notes were indexed. This happened with `./Private`, the folder's full path, another letter case (`private` for `Private`, and the templates folder as Obsidian's settings spell it), and `Work\Private` on Windows. All of those now mean the folder they name. An entry that still matches nothing gets a warning from `sync`, `status` and `doctor`, is no longer named by `status`, and `init --exclude` refuses it. Covered by a unit test.

### Known limits

- Verified on Apple Silicon Macs. Windows, Intel Macs and Linux are not yet verified.
- Every benchmark so far comes from one machine. See [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md).
- One current vault at a time. No MCP server, no file watcher, no reranking.
- Whether an `obsidian://` link opens when clicked has been unit-tested for format and not yet confirmed by a person on every platform.
- The exact-words list reads a note's title, headings and text. An alias in a note's properties is found by meaning only.
- Exact words mean exact: no word stems, and an accented letter stored as two characters does not match the same letter stored as one.
- The exact-words list shows at most 3 passages. A name or code inside a long question may not reach it: put it in double quotes, or pass it as its own wording.
- A quoted phrase built around one very common word can be missed in a large vault (at most 300 passages are checked per wording).
- The exact-words table is checked in full by `status --verify`, not by plain `status`. `rebuild` makes it again.
- One edit to a very long note (over a hundred passages) re-reads every passage of that note, which takes several seconds.

### Not in this release

- **Warm mode** (an optional helper that keeps the reading model loaded between searches). Not built yet. Nothing of it is in this release: no background process, no setting. Planned, off by default.
- A release on the npm registry. Install from the GitHub tag for now.
- An MCP server, a file watcher, more than one current vault.

[Unreleased]: https://github.com/HeroForgeAI/vault-mirror/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/HeroForgeAI/vault-mirror/releases/tag/v0.1.0
