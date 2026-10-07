# How it works, under the hood

For engineers. The short version is in the [README](../README.md#how-it-works). The full design, with every measurement that shaped it and three rounds of review findings, is in [SPEC.md](SPEC.md).

A small Node command-line tool on [ruvector](https://github.com/ruvnet/ruvector): incremental sync by content fingerprint, passages cut at headings, real deletes, a reading model that runs on your computer, and results that name the exact note, heading and line.

## One sync, six stages

1. **Trigger.** You or your AI run `sync`.
2. **Extract.** Walk the vault and compare each note's size and date with what was recorded. Only a note that looks different is read and fingerprinted (SHA-256 of its bytes).
3. **Filter.** Skip what you left out: `exclude` folders, `index: false`, Obsidian's own "Excluded files", dot-folders and nested vaults. Each reason is counted, so the numbers always add up.
4. **Transform.** Cut the note into short passages at its headings. Each passage carries its `Title > Heading` trail.
5. **Embed.** A small reading model on your computer turns each passage into a vector: a list of numbers that stands for its meaning.
6. **Load.** Replace that note's old passages with the new ones.

A manifest (the tool's record) holds every note's fingerprint. A second run reports zero changes. Each run writes one line to `logs/sync.log`, with counts only: no note names, no note text, no search questions.

## The engineering decisions, with their reasons

- **Passages are sized in real tokens.** The reading model, all-MiniLM-L6-v2 (384 numbers per passage), reads only the first 126 tokens of whatever it is given. So passages are packed to about 110 tokens, counted with the model's own vocabulary, and nothing in a note is invisible to search.
- **The index is exact.** ruvector is opened with a flat (exact) index, not its default approximate one. A flat index compares the question with every passage, so it does not skip one, a replaced passage is found once, and a delete is a real delete. That costs 0.016 s at 50,000 passages. Every new index file is self-tested for this, and `doctor` proves it on your machine.
- **Why ruvector.** One package brings both the vector store and the local model runner, with no server, and the people this was built for already use it. With a flat index the engine does little that sqlite-vec, LanceDB or a plain float file could not, and none of those was compared. The engine sits behind one interface in `src/engine/`, and a built-in exact scan already takes over where ruvector has no native build.
- **The tool keeps its own source of truth.** Passage text, vectors and the manifest live in plain files the tool owns (the "sidecar"). The ruvector file is a cache of ids and vectors, rebuilt from the sidecar in about a second with no re-reading. That is why `rebuild` is always safe.
- **Crash order.** Writes go vectors, then the passage record, then the manifest. A sync killed with `kill -9` resumes and reads only the remainder (acceptance step 14).
- **A damaged index cannot crash the tool.** A short child process opens an existing engine file first. If it dies, the file is thrown away and rebuilt from the sidecar.
- **Two runs queue.** Two small lock files are held until the process exits. There is no stuck lock for a person to delete.
- **Search is two lists.** By meaning (cosine similarity, best passage per note) and exact words (BM25 over the tool's own passage store). They are never merged into one ranking: one test showed that merging lowers recall on reworded questions.
- **Gentle by default.** A first sync uses at most 4 readers at below-normal priority. A search never starts the reader pool.
- **One direct runtime dependency:** `ruvector`, pinned to an exact version with a shrinkwrap. An install adds 162 packages and 67 MB, including prebuilt native binaries for your platform (measured on macOS arm64). No build step, no install script, no YAML library, no argument parser, no test framework.
- **Memory.** A search peaks at 0.71 GB on a small vault and 0.84 GB at 50,000 passages, over the tool's own 0.7 GB budget. `status`, which loads no model, peaks at 0.07 GB; the difference is the model runtime and the open index.

## What "in step" means

Every note that belongs in the index is in it, once, as it is on disk now. `status` is the proof. It exits 0 either way, because "not yet" is an answer and not a failure.

```text
$ vault-mirror status
garden-notes   ~/garden-notes
In step: yes, with these folders left out: Templates (checked by size and date; --verify reads every note)

  Notes on disk                       16
  Left out on purpose                  1   excluded folder 1 · excluded in Obsidian 0 · index: false 0 · empty 0
  Notes that belong in the index      15
  Notes in the index                  15
  Passages recorded                   32
  Passages in ruvector                32
  Waiting to sync                      0   new 0 · changed 0 · removed 0
  Could not read                       0

Last sync Oct 7, 2026 00:15, took 2.0 s. Model all-MiniLM-L6-v2. vault-mirror 0.1.0, ruvector 0.3.3.
```

It prints `In step: yes` only when nine checks all hold. `status --json` lists each by name:

| Check | What has to be true |
| --- | --- |
| `disk-matches-manifest` | The notes on disk that belong are the notes the index lists |
| `nothing-pending` | No note is new, changed or removed since the last sync |
| `nothing-skipped` | No note failed to read |
| `counts-add-up` | Notes on disk = notes in the index + notes left out |
| `passages-match` | Passages recorded = passages in ruvector |
| `engine-current` | The ruvector file was built from the current record |
| `exact-words-match` | The exact-words table lists the same passages, note for note |
| `no-old-text` | No replaced passage is still stored |
| `versions-match` | The chunker, model and engine are the ones the index was made with |

`status --verify` goes further: it fingerprints every note, checks every passage id in the engine, and compares the engine's answers with an exact scan. `status --list` names what is left out or waiting. The definitions are in [section 11 of the spec](SPEC.md#11-what-in-step-means-and-how-it-is-proved).

## An edit, a rename, a delete

Edit a note, and its old passages are replaced. Rename one, and it moves. Delete one, and it is gone from the index.

```text
$ vault-mirror sync                      # after adding a section to Tomatoes.md
Checked 16 notes: 0 new, 1 changed, 0 removed, 1 left out.
Done in 0.8 s. In step: 15 notes on disk = 15 notes in the index (33 passages).
added 0 · updated 1 · renamed 0 · removed 0 · unchanged 14 · left out 1

$ vault-mirror sync                      # after renaming Pickles.md to Quick pickles.md
Checked 16 notes: 1 new, 0 changed, 1 removed, 1 left out.
Done in 0.6 s. In step: 15 notes on disk = 15 notes in the index (33 passages).
added 0 · updated 0 · renamed 1 · removed 0 · unchanged 14 · left out 1

$ vault-mirror sync                      # after deleting Packing list.md
Checked 15 notes: 0 new, 0 changed, 1 removed, 1 left out.
Done in 0.1 s. In step: 14 notes on disk = 14 notes in the index (32 passages).
added 0 · updated 0 · renamed 0 · removed 1 · unchanged 14 · left out 1
```
