# Compared with other tools

Each of these is good at what it is built for. The other columns come from each project's own README as read on Oct 7, 2026, at the version named. A dash means that README does not say; it is not a claim that the tool lacks the feature.

| | vault-mirror 0.1.0 | [qmd](https://github.com/tobi/qmd) v2.8.3 | [basic-memory](https://github.com/basicmachines-co/basic-memory) v0.23.2 | [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) 4.7.2 | [obsidian-brain](https://github.com/ruvnet/obsidian-brain) v0.1.0 |
| --- | --- | --- | --- | --- | --- |
| Runs as | a shell command | a shell command | an MCP server and a shell command | an Obsidian plugin | an Obsidian plugin and two local services |
| Never writes a note | ✓ | – | ✗ (two-way by design) | – | – |
| A deleted note leaves the index | ✓ | – | – | – | – |
| One command proves index = vault | ✓ | – | – | – | – |
| One ranked list that blends keyword and meaning | ✓ (after 0.1.0, not yet released) | ✓ | ✓ | – | – |
| Then reranks with a second model | ✗ (measured, not built in) | ✓ | ✓ (optional, off by default) | – (a rerank stage is a Pro option) | – |
| MCP server | ✗ | ✓ | ✓ | – | ✓ |

If ranking quality is what you need, use qmd: it is the stronger search tool. It rewrites the question, blends keyword and meaning with rank fusion, and reranks the top 30 with a model of about 640 MB. vault-mirror blends the two lists with a plain rule and no second model: a passage that holds most of the question's exact words gets a bonus on its match by meaning. Three small reranking models were measured and made the list worse on our questions, so none is built in ([docs/BENCHMARKS.md](BENCHMARKS.md#the-blended-list)). The two tools have not been measured against each other. vault-mirror puts its effort into the read-only and 1:1 guarantees.

vault-mirror is also not a privacy wall (passages a search returns go to your AI's service), not a background service (no daemon, no file watcher), not a backup, and not compliance tooling. Your AI can still edit notes if you ask it to. That is your AI, not this tool.

Back to the [README](../README.md#when-plain-file-search-is-enough-and-when-this-helps).
