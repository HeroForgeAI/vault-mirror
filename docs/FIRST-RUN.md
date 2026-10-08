# What a first run prints

So you know what success looks like. Everything here is real output. The vault is 15 invented notes: the one in [`tests/fixtures/vault`](../tests/fixtures/vault) without its edge-case folders, built under the name `garden-notes` by [`docs/demo/setup.sh`](demo/setup.sh). Your own names, counts and times will differ, and the progress figures change a little from run to run.

## The four commands

```text
$ vault-mirror init ~/garden-notes
Set up garden-notes (15 notes). It only reads your notes. The index lives in ~/.vault-mirror/indexes/garden-notes-3b1014fc, outside the vault, and holds a copy of your notes' text on this computer only.
Left out the templates folder "Templates". To include it, remove it from "exclude" in ~/.vault-mirror/config.json.
Wrote the vault rule to CLAUDE.md and AGENTS.md in ~/my-project. (Wrong folder? Run init again with --project <folder>.)
Next: vault-mirror sync

$ vault-mirror sync
Syncing garden-notes with 4 readers, at low priority. It only reads your notes.
Your computer may feel a little slower and its fan may run while this reads your notes. That is normal. You can keep working, and it picks up where it left off if it is interrupted.
Checked 16 notes: 15 new, 0 changed, 0 removed, 1 left out.
Reading 0% · 0 of 32 passages
Reading 46% · 15 of 32 passages · 20/s
Reading 100% · 32 of 32 passages · 21/s
Done in 2.3 s. In step: 15 notes on disk = 15 notes in the index (32 passages).
added 15 · updated 0 · renamed 0 · removed 0 · unchanged 0 · left out 1

$ vault-mirror sync
Nothing changed. In step: 15 notes on disk = 15 notes in the index (32 passages). 0.01 s.

$ vault-mirror search "why is the fruit going black underneath" -k 1
1. Tomatoes  ›  Problems                                     match 0.42
   /Users/you/garden-notes/Garden/Tomatoes.md:13
   obsidian://open?vault=garden-notes&file=Garden%2FTomatoes.md%23Problems
   Blossom end rot shows up as a dark patch on the base of the fruit. It comes from uneven watering, not disease.
Returned about 22 words in 1 passage, from 1 note that holds about 62 words.
```

`/Users/you` stands in for the folder the example ran in. The tool prints the full path so your AI can open the file.

The last line of a search counts, in words, what came back and what the notes it came from hold. It is how you see, on your own vault, how much your AI was handed to read. `--quiet` leaves it out for one search, and `"readingSummary": false` in the [settings](CONFIGURATION.md) turns it off.

## On a larger vault

Fifteen notes are read in two seconds. On a few hundred notes the sync takes a few minutes, and the line you watch is the progress line. From a first sync of a 176-note practice vault (a public set of English help pages):

```text
Checked 176 notes: 176 new, 0 changed, 0 removed, 0 left out. 144 other files (images, PDFs and the like) are not notes and were not read.
Reading 24% · 549 of 2,199 passages · 35/s · about 50 s left
Done in 1 min 1 s. In step: 176 notes on disk = 176 notes in the index (2,199 passages).
```

The first time is the slow one. You can keep working, and it picks up where it left off if it is interrupted. After that, only notes that changed are read.

## Lines you may or may not see

Each of these appears only when it applies. None of them means something is wrong.

| Line | When | What to do |
| --- | --- | --- |
| "Downloading the reading model once (about 90 MB). After this, everything runs on your computer." | The first command that needs the model, usually `doctor` or the first `sync` | Nothing. It is the only download |
| "Obsidian has not opened this folder as a vault yet, so links to notes will not work. Open it in Obsidian once to fix that." | The folder has never been opened in Obsidian, which is true of any practice or copied vault | Nothing, or open the folder in Obsidian once. File paths in results work either way; only the `obsidian://` line is missing until then |
| "Open this folder as a vault in Obsidian once, and links will work." | At the top of a search, for the same reason as the line above | The same: nothing, or open the folder in Obsidian once |
| "Left out the templates folder ..." | The vault has a templates folder | Nothing. Templates are left out by default |
| "... other files (images, PDFs and the like) are not notes and were not read." | The vault holds files that are not `.md` | Nothing |
| npm's "packages are looking for funding" | Every npm install | Ignore it. It is npm's own note |

## If you start the first sync in the background

`vault-mirror sync --detach` returns at once:

```text
Sync started in the background. Ask "is my vault in sync?" to see progress.
```

Right after that, `vault-mirror status` says "A sync is running" with a percent. In the first moments a search can answer "Nothing is indexed yet." That is the same sync still starting. Do not start a second one. Wait a little and ask `status` again.

## The check before any of it

`vault-mirror doctor` checks this computer and ends with one next step. Before a vault is set up, its last line is:

```text
Ready. Next: vault-mirror init "<path to your vault>"
```
