# Settings

You can leave these alone. `init` writes one file, `~/.vault-mirror/config.json`, and the defaults work.

| Key | Default | Meaning |
| --- | --- | --- |
| `vault.path` | set by `init` | The one current vault. `init` on another folder switches to it; each vault keeps its own index |
| `vault.exclude` | `[]`, plus your templates folder if you have one | Folders or files to leave out |
| `vault.obsidianExcludes` | `true` | Also leave out what Obsidian's "Excluded files" setting names |
| `vault.minWords` | `3` | A section with fewer words makes no passage |
| `vault.workers` | `"auto"` | Readers for a large sync. Never more than 4 unless you set a number |
| `vault.resultCount` | `8` | Notes returned by a search (`-k` overrides it) |
| `vault.screen` | `"report"` | Flags passages that look like they hold a password or key, and masks them in results. `status --screen` lists them |

`VAULT_MIRROR_HOME` moves the index folder. `RUVECTOR_CACHE_DIR` moves the model cache (ruvector's own setting). All commands and flags: `vault-mirror --help`.

The MCP server (`vault-mirror mcp`) reads the same settings file. It takes three options of its own: `--home <folder>` (the same as `VAULT_MIRROR_HOME`, for that server), `--vault <folder>` (serve this vault only) and `--idle-minutes <n>` (how long the reading model stays loaded after a search; the default is 5). See [MCP.md](MCP.md#which-vault-it-serves).

One vault is current at a time. `vault-mirror init <other vault>` switches, and each vault keeps its own index, so switching back costs nothing. To use two vaults side by side, give each its own home folder with `VAULT_MIRROR_HOME`.
