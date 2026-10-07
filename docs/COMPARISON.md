# Compared with other tools

Each of these is good at what it is built for. The other columns come from each project's own README as read on Oct 7, 2026, at the version named. A dash means that README does not say; it is not a claim that the tool lacks the feature.

| | vault-mirror 0.1.0 | [qmd](https://github.com/tobi/qmd) v2.8.3 | [basic-memory](https://github.com/basicmachines-co/basic-memory) v0.23.2 | [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) 4.7.2 | [obsidian-brain](https://github.com/ruvnet/obsidian-brain) v0.1.0 |
| --- | --- | --- | --- | --- | --- |
| Runs as | a shell command, and an MCP server (new since 0.1.0) | a shell command | an MCP server and a shell command | an Obsidian plugin | an Obsidian plugin and two local services |
| Never writes a note | ✓ | – | ✗ (two-way by design) | – | – |
| A deleted note leaves the index | ✓ | – | – | – | – |
| One command proves index = vault | ✓ | – | – | – | – |
| Blends keyword and meaning, then reranks | ✗ | ✓ | ✓ (reranking is optional) | – (a rerank stage is a Pro option) | – |
| MCP server | ✓ (new since 0.1.0, not in a release yet; it only reads notes) | ✓ | ✓ | – | ✓ |

If ranking quality is what you need, use qmd: it is the stronger search tool. vault-mirror keeps two lists side by side and puts its effort into the read-only and 1:1 guarantees.

vault-mirror is also not a privacy wall (passages a search returns go to your AI's service), not a background service (no daemon, no file watcher), not a backup, and not compliance tooling. Your AI can still edit notes if you ask it to. That is your AI, not this tool.

Back to the [README](../README.md#when-plain-file-search-is-enough-and-when-this-helps).
