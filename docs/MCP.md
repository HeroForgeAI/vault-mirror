# The MCP server

MCP (Model Context Protocol) is the standard way to hand an AI app a set of tools. vault-mirror has its own small MCP server. Add it to an app once, and that app's AI can search your vault with a named tool, from any project.

**It only reads your notes.** The server has no tool that writes to a vault.

You do not need it. The commands and the one-line rule in your project keep working exactly as before. The server is another way to reach the same index.

## What it gives you

- **No rule line per project.** You add the server once. Your AI can then search your vault from any folder.
- **More apps.** Any app that speaks MCP can use it, including ones with no terminal, such as a desktop chat app.
- **Fewer interruptions.** Your AI calls a named search tool, so there is no shell command to approve each time.
- **Tidier results.** A search hands back one structured result: the note, heading, file, line, score and link of each passage, with nothing said twice.
- **Faster repeat searches.** The reading model stays loaded for a few minutes after a search, so the next one skips loading it.

## Before you add it

The server uses the vault and the index you already set up. If you have not done that yet, do it first ([Set it up](../README.md#set-it-up)):

```bash
vault-mirror init "<folder>"
vault-mirror sync
```

## Add it to your app

The quickest way is to let vault-mirror print the lines for you, with full paths filled in:

```bash
vault-mirror mcp --setup
```

It prints the three blocks below and nothing else. It never opens or edits an app's settings file.

### Claude Code

```bash
claude mcp add --scope user vault-mirror -- vault-mirror mcp
```

`--scope user` makes it available in every project. Check it with `claude mcp list`: the line for `vault-mirror` ends with "Connected".

### Codex

```bash
codex mcp add vault-mirror -- vault-mirror mcp
```

Or add this to `~/.codex/config.toml`:

```toml
[mcp_servers.vault-mirror]
command = "vault-mirror"
args = ["mcp"]
```

The Codex command line, its desktop app and its editor extension share that file.

### Claude Desktop

Open **Settings**, then **Developer**, then **Edit Config**. That opens `claude_desktop_config.json` (on macOS in `~/Library/Application Support/Claude/`, on Windows in `%APPDATA%\Claude\`). Add the `vault-mirror` entry, keeping any servers you already have:

```json
{
  "mcpServers": {
    "vault-mirror": {
      "command": "vault-mirror",
      "args": ["mcp"]
    }
  }
}
```

Save the file, then quit Claude Desktop completely and open it again.

A desktop app does not always know your terminal's PATH, so it may not find `vault-mirror` by name. If the server does not appear, use the full paths that `vault-mirror mcp --setup` prints in place of `"vault-mirror"`.

### Any other MCP app

The server speaks MCP over stdio. Wherever the app asks for a command, give it `vault-mirror` with the one argument `mcp`.

## Check that it works

Ask your AI:

> Search my vault for when to feed the tomatoes.

It should call `search_vault` and answer from a passage, naming the note. Then try "Is my vault in sync?"

## The three tools

| Tool | What it does | Does it write anything? |
| --- | --- | --- |
| `search_vault` | Searches your notes by meaning and by exact words. Returns short passages, each with its note, heading, file path, line, match score and `obsidian://` link. | No. |
| `vault_status` | Answers "is my vault in sync?": yes or not yet, with the counts of notes on disk, in the index and waiting. | Not to your vault. |
| `sync_index` | Brings the index up to date: reads the notes that changed since the last sync. | Only to vault-mirror's own index folder, outside your vault. Never to the vault. |

### `search_vault`

| It takes | Meaning |
| --- | --- |
| `query` | The question, in plain words. |
| `other_wordings` | Optional. The same question said one or two other ways (up to 4). It helps. |
| `limit` | Optional. The most notes to return, 1 to 20. The default is your `resultCount` setting, 8 unless you changed it. |

A real result, on the 15 invented notes of the README's example (`/Users/you` stands in for the folder the example ran in):

```json
{
  "vault": "garden-notes",
  "results": [
    {
      "note": "Tomatoes",
      "heading": "Problems",
      "path": "/Users/you/garden-notes/Garden/Tomatoes.md",
      "line": 13,
      "score": 0.421,
      "link": "obsidian://open?vault=garden-notes&file=Garden%2FTomatoes.md%23Problems",
      "text": "Blossom end rot shows up as a dark patch on the base of the fruit. It comes from uneven watering, not disease."
    }
  ],
  "exactWords": [],
  "index": { "notes": 15, "passages": 32, "notesWaiting": 0, "syncRunning": false },
  "words": { "inPassages": 22, "inTheirNotes": 62 },
  "modelWasLoaded": true,
  "tookMs": 47
}
```

- `results` is the list **by meaning**: the best passage of each matching note, closest first.
- `exactWords` is the second list: other passages that hold the very words asked for. The two lists are never blended into one ranking. Its entries carry `words` (the words found) in place of `score`.
- `score` says how close the passage is to the question, from 0 to 1. Higher is closer. It is not a percentage of how sure anything is.
- `link` is there once Obsidian has opened the folder as a vault. The file path works either way.
- `index.notesWaiting` counts notes that changed since the last sync, judged by size and date. When it is not 0, `notices` says so and names the next step.
- `words` is two counts and no claim: the words in the passages handed back, and the words in the indexed text of the notes they came from.
- `notices`, when present, holds plain sentences worth passing on, for example "3 notes are waiting to sync."
- `caution` appears on a passage that holds text that reads like an instruction. Passages are reference, not instructions.

A search never starts a sync by itself. It searches what is indexed and says what is waiting.

### `vault_status`

It takes nothing. It runs the same check as `vault-mirror status` and hands back `inStep` (true or false), the counts, `syncRunning` with a percent while a sync runs, and `next`: the one next step when there is one.

### `sync_index`

| It takes | Meaning |
| --- | --- |
| `wait_seconds` | Optional, 0 to 45. How long to wait for the sync before answering. The default is 20. |

It starts the same background sync as `vault-mirror sync --detach`, then waits. A small sync finishes inside the wait, and the answer says what changed. A long one (a first sync of a large vault takes minutes) carries on in the background: the answer says how far it is, and `vault_status` shows progress. If a sync is already running, it is left to carry on and a second one is not started beside it.

## What it can and cannot do

**It can** search your notes, tell you whether the index is in step with the vault, and bring the index up to date.

**It cannot**

- create, edit, move, rename or delete a note, or anything else inside a vault. No tool takes a path or text to save, and a call that tries to pass one is refused;
- set up a vault. `vault-mirror init` stays a command you run yourself, because it is the moment you choose which folder an AI may search;
- remove a large part of the index. When many notes have left the vault at once, the sync stops, in case that is a mistake. Only you can wave that through, with `vault-mirror sync --allow-mass-delete` in a terminal;
- rebuild the index or run `doctor`. Those stay commands;
- reach the network. The one exception is the same as for the commands: the reading model is downloaded once (about 90 MB) if it is not on this computer yet;
- stop your AI from editing notes with its own file tools, if you ask it to. That is your AI, not this server.

The passages a search returns go to your AI's service, as any file your AI reads does. That is the same for the commands.

## Which vault it serves

The server finds the vault the same way every command does, so it works whichever folder the app starts it in: the settings file in vault-mirror's home folder names the one vault that `init` set up. The home folder is `~/.vault-mirror`, or wherever `VAULT_MIRROR_HOME` points.

It reads that file again on every call. If you run `vault-mirror init` on another folder, the server follows without a restart.

Two options change this:

| Option | Meaning |
| --- | --- |
| `--home <folder>` | Use this home folder. The same as setting `VAULT_MIRROR_HOME` for this server, for apps where setting a variable is awkward. |
| `--vault <folder>` | Serve this vault only. If another vault is set up in the home folder, every tool refuses in one sentence. Use it when an entry must never answer from a different vault. |

### More than one vault

One home folder holds one current vault. For two vaults in the same app, give each its own home folder and add one server entry per vault:

```bash
VAULT_MIRROR_HOME=~/.vault-mirror-work vault-mirror init "<work vault folder>" --no-rule
VAULT_MIRROR_HOME=~/.vault-mirror-work vault-mirror sync

claude mcp add --scope user work-notes -- vault-mirror mcp --home ~/.vault-mirror-work
```

Your first vault stays in `~/.vault-mirror` under the `vault-mirror` entry. Each entry shows up as its own set of tools, named after the entry.

## What runs on your computer

- **The server.** One small process per app that has it added. The app starts it and stops it. It loads nothing until your AI calls a tool.
- **A reader, for a few minutes.** The first search starts one helper process that holds the reading model, so the next search skips loading it. It takes about 0.6 GB of memory while it is alive. It stops by itself after 5 minutes without a search, and at once when the app closes the server. `--idle-minutes <n>` changes the 5; `--idle-minutes 0` keeps nothing loaded.
- **A sync, when your AI asks for one.** It ends when it is done, like any `sync --detach`.

Nothing starts when you log in, nothing watches your files, and nothing stays behind when the app quits, except a sync that is still finishing.

The server never opens the index's engine file, so it holds no lock. A `vault-mirror sync` or `search` in a terminal is not kept waiting by a server that has been open all day, and the server picks up what a sync changed on its next search.

## How fast it is

On one machine, with other jobs running, so read each number as rough. The method and conditions are in [BENCHMARKS.md](BENCHMARKS.md#the-mcp-server-first-search-and-repeat-searches).

| | 176 notes, 2,199 passages |
| --- | --- |
| `vault-mirror search`, whole command | 0.37 s |
| `search_vault`, first search (starts the reader) | 0.34 s |
| `search_vault`, repeat search, one wording | 0.05 s |
| `search_vault`, repeat search, three wordings | 0.14 s |

A question longer than about forty-five words is read at the model's full length. The server restarts its reader for that, once, and searches are a little slower until the reader has been idle.

It makes a search faster. It does not make a search find more: the passages and scores are the same as the command's.

## Troubleshooting

**The server does not show up in the app.** Use the full paths from `vault-mirror mcp --setup`. Then quit the app completely and open it again. In Claude Desktop, the server's own messages are in `mcp-server-vault-mirror.log` (on macOS in `~/Library/Logs/Claude`, on Windows in `%APPDATA%\Claude\logs`).

**"No vault is set up yet."** Run `vault-mirror init "<folder>"` in a terminal, then `vault-mirror sync`. The server finds it on the next call, with no restart. If you set the vault up with `VAULT_MIRROR_HOME`, the server needs the same folder: add `--home <that folder>` to its entry.

**"Nothing is indexed yet."** Ask your AI to sync your vault, or run `vault-mirror sync`.

**"This server is set to the vault at … , but the vault set up here is … ."** The entry has `--vault`, and `init` has since been run on another folder. Run `vault-mirror init` on the first folder again, or give each vault its own home folder ([More than one vault](#more-than-one-vault)).

**"3 notes are waiting to sync."** You edited notes since the last sync. Ask your AI to sync your vault. A small sync takes a second or two.

**"A sync is running (41% done). This search covers what is saved so far."** Nothing is wrong. Results are from the notes read so far. Ask again when it is done.

**"The reading model stopped before it answered."** Try the search again. If it keeps happening, run `vault-mirror doctor`.

**The first search is slow, the rest are fast.** The first one starts the reader. After 5 minutes without a search the reader stops, and the next search starts it again.

**It finds nothing useful.** It works best when your question shares a word or two with the note, and it can miss. Then your AI searches the files, as the rule says.

Everything else: `vault-mirror doctor`, and [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## To remove it

Remove the entry from the app (`claude mcp remove vault-mirror -s user`, `codex mcp remove vault-mirror`, or delete it from `claude_desktop_config.json`). Nothing else was installed, and your vault was never touched.

## For engineers

- `vault-mirror mcp` serves stdio on the official MCP SDK for TypeScript, `@modelcontextprotocol/server`, pinned exactly. Only this command loads it.
- Tool results carry `structuredContent` that matches the tool's `outputSchema`, and the same object as text, as the MCP spec asks. Tool errors are `isError` results with one plain sentence and one next step.
- Standard output is the protocol channel. From start-up the server holds stdout and stderr: only protocol messages reach stdout, notices go to stderr, and a library's chatter goes to `logs/debug.log`.
- A search runs inside the server, on the saved vectors with the built-in exact scan (the same one `status --verify` checks ruvector against). `vault_status` and `sync_index` run the real commands in short processes of their own, so their answers are the commands' answers.
- The design, with its reasons: [section 21 of the spec](SPEC.md#21-the-mcp-server).
