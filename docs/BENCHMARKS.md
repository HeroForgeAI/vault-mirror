# Benchmarks

Measured numbers for vault-mirror 0.1.0. Nothing here is a promise for another computer.

**Read this first.** Every number below was taken on one machine while other heavy jobs were running on it (load average between 8 and 16 on 16 cores). So every speed is labelled **busy** and is a rough lower bound. The README quotes only the sections "Measured again for the README" and "A real vault of about two thousand notes" below, the scale check and the recall check, each with its load average beside it. No number here has been taken on an idle machine yet.

| | |
| --- | --- |
| Machine | Apple M4 Max, 16 cores, 64 GB |
| Node | 24.15.0 |
| Engine | `ruvector` 0.3.3, `@ruvector/core` 0.1.32, native package 0.1.30, flat index, cosine |
| Reading model | the default entry in `src/embed/models.js` |
| Date | Oct 6, 2026 |
| Priority | every sync ran at `nice -n 15` with 4 readers |

Three sets of data were used:

- **Fixture**: the invented vault in `tests/fixtures/vault` plus invented filler notes made at test time (about 170 notes, about 640 passages).
- **Practice vault**: a public set of English help pages used as a stand-in vault (176 notes, 2,199 passages). Real text, real vectors.
- **Scale check**: `tests/bench/scale.mjs`, 2,000 invented notes and 40,000 passages whose vectors are **synthetic** (clustered, unit length). The engine, the sidecar, the vault walk and the question embedding are real. Search results mean nothing there; only the timings do.

## The performance budget (spec section 15)

| Operation | Budget | Measured | Data | Machine state |
| --- | --- | --- | --- | --- |
| First sync, 4 readers | 30 minutes or less at about 40,000 passages | 60.6 s for 2,199 passages: 36 passages a second. 17 min 7 s for 51,572 passages with 6 readers (see "A real vault of about two thousand notes") | Practice vault; a real vault | busy |
| Sync with nothing changed | 2 s or less (0.5 s for about 2,000 notes) | 0.05 s at 176 notes; 0.06 s at 2,000 notes. The model and the engine are not loaded | Practice vault; scale check | busy |
| Sync after one edited note | 6 s or less (1.5 s wanted) | 0.59 s (one passage re-read) at 640 passages; 0.93 s at 40,000 passages, which includes rewriting the whole sidecar and applying the change to the engine | Fixture; scale check | busy |
| Search, cold process, nothing changed | 1.5 s or less (0.7 s wanted at about 40,000 passages) | 0.34 s at 2,199 passages; 0.46 s at 40,000; 0.50 s with three wordings in one call | Practice vault; scale check | busy |
| Engine reload from the sidecar | 5 s or less | 0.6 s for 40,000 rows (the whole `rebuild` command) | Scale check | busy |
| `status` | 2 s or less (0.3 s wanted) | 0.12 s at 176 notes and 2,199 passages; 0.23 s at 2,000 notes and 40,000 passages. The model is not loaded | Practice vault; scale check | busy |
| `status --verify` | 60 s or less | 0.31 s at 2,199 passages; 2.8 s at 40,000 | Practice vault; scale check | busy |
| Peak memory, sync with 4 readers | 2 GB | 1.85 GB, and 1.95 GB in a second person's re-run at load average 8: about 1.9 GB. With 6 readers on the real vault, about 2.7 GB | Practice vault; a real vault | |
| Peak memory, search | 0.7 GB | 0.79 GB at 40,000 passages. **Over the budget by about 0.1 GB** | Scale check | |
| Peak memory, `status` and a sync with nothing changed | | 0.25 GB and 0.07 GB at 40,000 passages | Scale check | |
| Disk | 300 MB or less | 14 MB for 2,199 passages (5 MB sidecar, 8.5 MB engine file); 208 MB for 40,000 passages (129 MB engine file, the rest sidecar) | Practice vault; scale check | |
| CPU while syncing | At most 4 readers, below-normal priority | 216 CPU-seconds over 60.6 s: about 3.6 cores | Practice vault | busy |
| Background activity | None | No process started by any command was alive after it returned (acceptance steps 17, 24 and 25); a sync returned 8 ms after its last line | Fixture; practice vault | |

### Where a search's time goes

One cold `search` process at 40,000 passages, 0.46 s in all (scale check, busy):

| Part | Time |
| --- | --- |
| Start Node and load the tool | about 0.03 s |
| Look at the vault for changes (2,000 notes, size and date only) | 0.02 s (0.00 s with `--no-sync`) |
| Load the reading model and embed the question | 0.27 s |
| Open the engine file, after the probe child has checked it | 0.13 s |
| Search 40,000 rows | 0.012 s |
| Read the passages for the results | 0.001 s |

The probe (a child process that opens the existing engine file first, so a damaged file cannot crash the tool) runs while the model loads, so it adds little to the total. Its own cost is close to the whole `status` command, which is one vault walk plus one probe: 0.12 s at 2,199 passages and 0.23 s at 40,000.

A question is embedded at the smallest padding that gives the same vector. Padding 16, 32, 64 and 128 gave bit-identical vectors for three questions; the embed itself took about 0.02 s at padding 16 against about 0.11 s at 128.

## The exact-words list

Added after the numbers above were taken, on branch `feat/exact-words`. Same machine, same versions, Oct 6, 2026. The load average is written beside each number; none of these was taken on a quiet machine, so each is **busy** and a rough lower bound like the rest of this file.

### Scan the passage store for every question, or keep a table?

Measured before choosing, on 50,000 real passages (the practice vault's 2,199 passages repeated under other paths; 19 MB of `passages.jsonl`), one question with five distinctive words, single thread, load average about 10:

| Way | Time for one question | Notes |
| --- | --- | --- |
| Read the passage store, parse and tokenise every passage, score | 0.21 s (median of 3) | Reading the file is 0.002 s of that; the rest is parsing and tokenising. Alone it would use a third of the search budget |
| Load a table written at sync time, find the words, rank | 0.004 s (load 0.0005 s, find 0.002 s, rank 0.001 s) | The same best score to 12 digits |

So the tool keeps a table (`words.bin`). Its costs on the same 50,000 passages: 5.7 MB on disk; 0.29 s to make from nothing once the records are parsed; 0.008 s to bring in step when every note is unchanged.

### Search speed with the list (scale check, 2,000 notes, 50,000 passages)

`tests/bench/scale.mjs --notes 2000 --passages 50000 --runs 7`, cold process each time, median of 7. The scale check's invented text is a hard case for exact words: every word sits in about a tenth of all passages, so every question has thousands of candidates. Two runs are listed; the first was taken at load average 7.8 to 9.3, the second (after the last code change, which only touched `sync`) at 7.9 to 11.5.

| Search | Budget | Run 1 | Run 2 |
| --- | --- | --- | --- |
| One wording, with the exact-words list | under 0.7 s | 0.50 s | 0.54 s |
| One wording, `--no-exact-words` | | 0.50 s | 0.53 s |
| One wording with a quoted phrase | | 0.49 s | 0.54 s |
| One wording, with the quick sync look at 2,000 notes | | 0.52 s | 0.55 s |
| Three wordings in one call | | 0.55 s | 0.60 s |

Where the 0.50 s of run 1 goes (one wording, `--no-sync`; the tool's own `timings`, then what is left over):

| Part | Time |
| --- | --- |
| Look at the vault for changes | 0.001 s (0.018 s without `--no-sync`) |
| Load the reading model and embed the question | 0.260 s |
| Open the engine file, after the probe child has checked it | 0.146 s (the probe itself took 0.218 s, alongside the model load) |
| Search 50,000 rows by meaning | 0.016 s |
| The exact-words list: load the table, rank, read the passages back | 0.018 s |
| Read the passages for the results | 0.001 s |
| Start Node, load the tool, print, exit (what is left of the wall time) | about 0.06 s |

With three wordings the exact-words part was 0.023 s. On the practice vault (2,199 passages) and on the fixture it was 0.001 to 0.002 s.

Other commands at 50,000 passages, with the table in place (run 2 in brackets):

| Operation | Measured | Before the table, at 40,000 passages |
| --- | --- | --- |
| `status` | 0.27 s (0.27 s). It now also checks the table's note list against the manifest, one key per note | 0.23 s |
| Sync with nothing changed | 0.066 s (0.067 s). It reads the table's head only | 0.06 s |
| Sync after one edited note | 1.10 s (1.09 s), including the tidy rewrite of the whole sidecar and the table brought in step | 0.93 s |
| `rebuild` | 1.17 s (1.16 s): the engine file and the table, both made again from saved passages | 0.6 s |
| `status --verify` | 3.9 s (4.1 s), including a table made again from nothing and compared | 2.8 s |
| Table size | 12.1 MB for the scale check's invented text; 5.7 MB for 50,000 real passages; 0.26 MB for the practice vault | |
| Peak memory, search | 0.84 GB. **Over the 0.7 GB budget**, as it was before the table (0.79 GB at 40,000) | 0.79 GB |
| Peak memory, `status`; sync with nothing changed | 0.28 GB; 0.08 GB | 0.25 GB; 0.07 GB |

### The recall check

Acceptance step 21 on the practice vault (176 notes, 2,199 passages), load average 6.2 at the start and 12.1 at the end (speed does not enter these counts). Twenty questions about ten notes: ten **reworded** (asked in words the note does not use) and ten **exact** (asked with the note's own words). Each was asked with one wording and with three wordings in one call. A question counts as found when the expected note (or a listed alternate) is among what was printed.

| Questions | Wordings | By meaning, top 3 | By meaning, top 6 | Top 3 by meaning + exact-words list | By meaning, top 8 (the default list) | Default list + exact-words list |
| --- | --- | --- | --- | --- | --- | --- |
| Reworded | one | 9 of 10 | 9 of 10 | 9 of 10 | 9 of 10 | 9 of 10 |
| Reworded | three | 10 of 10 | 10 of 10 | 10 of 10 | 10 of 10 | 10 of 10 |
| Exact | one | 9 of 10 | 9 of 10 | 10 of 10 | 10 of 10 | 10 of 10 |
| Exact | three | 10 of 10 | 10 of 10 | 10 of 10 | 10 of 10 | 10 of 10 |

How to read it, and how not to:

- The exact-words list never took a found note away: in all 40 searches the list by meaning was the same with the list turned off (the step asserts this).
- With one wording, the list found the one exact question that the top 3 by meaning missed. With one wording it did not find the one reworded question the list by meaning missed (rank 10 by meaning); three wordings in one call did, at rank 1.
- This vault is small and these twenty questions come from one author, so nearly every cell is at its ceiling and the table cannot show how much the list helps on a large vault. The larger study that led to this feature (60 questions, outside this repo) found the index's top 3 plus a keyword top 3 at 27 of 30 reworded and 30 of 30 exact, against 25 and 24 for the top 6 by meaning. **Not a number to print**, as with every recall figure here.
- These counts did not hold at full size. See "Recall on a large vault" below.
- One more thing was tried and left out: listing a passage only when it scores at least 30%, 50% or 70% of the best passage for its wording. On these twenty questions it changed no count in the table, and across the forty searches it shortened the lists from 105 passages in all to 105, 101 and 85, so there was no evidence for the rule and it was not added.

### Recall on a large vault (one vault, 45 questions, one question writer)

This is the detail behind the README's plain-words summary of search quality. Measured Oct 7, 2026 with vault-mirror 0.1.0 on a real personal vault of 2,082 notes and 51,572 passages. The vault is private, so the question bank and the raw results are not in this repo and a reader cannot repeat this run. Every search used `search --no-sync`, and the vault was only read. Speed does not enter these counts.

The 45 questions were written by one person after reading a random sample of the notes. Four kinds:

- **Close** (15): a natural question that shares a few meaningful words with the note.
- **Far** (15): no content word of the question appears anywhere in the note (checked by script).
- **Exact** (10): a phrase, name or term taken from the note.
- **Topic** (5): answerable from several notes.

Each question has three wordings: the asker's own words, then two rephrasings of the kind an AI writes before it searches. Each was run with one wording and with all three in one call. "Default output" is what a search prints by default: the top 8 by meaning plus the exact-words list. "A right note" also counts a runner-up note that was listed as equally good before the run.

| Kind | Wordings | The one best note, top 8 by meaning | The one best note, default output | A right note, default output |
| --- | --- | --- | --- | --- |
| Close (15) | one | 9 | 11 | 15 |
| Close (15) | three | 10 | 11 | 15 |
| Far (15) | one | 1 | 1 | 2 |
| Far (15) | three | 10 | 11 | 15 |
| Exact (10) | one | 10 | 10 | 10 |
| Exact (10) | three | 10 | 10 | 10 |
| Topic (5) | one | 2 | 3 | 5 |
| Topic (5) | three | 3 | 4 | 5 |
| All (45) | one | 22 | 25 | 32 |
| All (45) | three | 33 | 36 | 45 |

What it says:

- **A question that shares words with the note is found.** Exact questions were found every time. Close questions found a right note nearly every time, though not always the one best note, because this vault holds several notes on most ideas.
- **One wording that shares no words with the note mostly misses.** The note was in the top 50 by meaning for 5 of the 15 far questions.
- **Several wordings in one call are the largest gain measured**, because the rephrasings bring in ordinary words the note does use.
- **The exact-words list helped only with three wordings.** With one far wording it found none of the 15.
- **Three wordings sometimes push the one best note down** a few places. Each time a sibling note took the slot.
- **A match number does not tell a hit from a miss.** A far miss still showed a score of about 0.45 to 0.55, against a median of 0.72 for exact questions.
- **Plain file search is a real safety net.** Keyword search with the words an AI would try after rephrasing found the best note about as often as the index with three wordings, and for none of the 15 with the asker's own far wording. What the index adds on this vault is ranking and less reading, not coverage. That is why the rule `init` writes tells the AI to search the files when the passages do not answer.

Limits:

- One vault, 45 questions, and one person who wrote the questions, the wordings and the answer keys. With 15 questions of a kind, one question is about 7 points. Read the table as "most", "about half" and "few", not as rates. **Not a number to print.**
- The question writer had read the notes, so the two rephrasings may be better than a real AI's. The gain from three wordings could be somewhat generous.
- The vault is unusual: one subject, private slang, and many near-duplicate notes. "The one best note" is often a judgment call, which is why two columns are shown.
- A hit means the right note was listed. It does not mean the passage shown answered the question.
- Not measured: any other vault, any other language, or a question writer who had not seen the notes.

## Reading models we compared

Before the default was fixed, every reading model that `ruvector` 0.3.3 names in its code was run through ruvector's own embedder and scored on the same questions. This was a study outside the tool: each model was selected with `initOnnxEmbedder({ modelId, maxLength })` in a small test harness. vault-mirror 0.1.0 itself ships one model, the default.

| | |
| --- | --- |
| Machine | Apple M4 Max, 16 cores, 64 GB, Node 24.15.0 |
| Engine | `ruvector` 0.3.3 |
| Date | Oct 6, 2026 |
| `maxLength` | written after each model's name (`@128`, `@256`): the padding length passed to the library. The table shows each model at its best tested setting, and bge-small-en-v1.5 at both |
| Load | another job was using about 4 cores (load average 7 to 15 on 16 cores), so every speed is **busy** and rough. The two-to-one speed ratio between the default and the 134 MB models held in every pass, including a second person's re-run with 2 workers |

**The question set.** A small in-house set, not a public benchmark: 60 questions, each with one known right note, all written by one person after reading the notes. Half were asked of the practice vault (176 notes of public English help pages), half of a 300-note sample of a private vault that is not in this repo, so a reader cannot repeat this run.

- **Reworded** (30): worded the way a person would ask, avoiding the note's own words.
- **Exact** (30): a phrase quoted from the note. Most were sentences; 7 of the 30 were one or two words.

A question counts as found when the right note is among the first 3 notes returned. The scores below are right notes found, out of 30, 30 and 60.

**What was not tested.**

- The tool's own chunker. The study cut passages at 180 words (and at 90 as a check, which moved the default by one question); the tool budgets 110 real tokens.
- Any model other than the default inside vault-mirror. The others ran through ruvector's embedder in the harness only.
- Any other machine, and a quiet machine.
- The whole private vault. The 300-note sample is an easier haystack.
- Text outside these two sets, and any language other than English. All six are English models.
- Models outside ruvector's list. None was run.
- bge-base-en-v1.5 with the pooling its model card describes, and e5-small-v2 at 512.

| Model | Numbers per passage | Download | Downloaded and ran through ruvector | Same vector size from the worker pool | Reworded (30) | Exact (30) | All (60) | Passages a second, 4 workers | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **all-MiniLM-L6-v2** @128 | 384 | about 90 MB | Yes | Yes | 22 | 20 | 42 | about 41 | **The default** |
| gte-small @128 | 384 | 134 MB | Yes | Yes | 19 | 24 | 43 | about 21 | The one alternative worth a look |
| bge-small-en-v1.5 @256 | 384 | 134 MB | Yes | Yes | 20 | 22 | 42 | about 9.5 | No gain, and about four times slower at this setting |
| bge-small-en-v1.5 @128 | 384 | 134 MB | Yes | Yes | 20 | 20 | 40 | about 21 | No gain |
| all-MiniLM-L12-v2 @128 | 384 | 134 MB | Yes | Yes | 20 | 21 | 41 | about 21 | About twice the cost, no gain |
| bge-base-en-v1.5 @128 | 768 | 437 MB | Yes, on one thread | No: 384 numbers came back where 768 were expected, with no error | 18 | 18 | 36 | not run (about 1.6 on one thread) | Not used |
| e5-small-v2 @256 | 384 | 134 MB | No: the download address returned 404. Scored with the file placed by hand | Yes, with the file placed by hand | 18 | 17 | 35 | about 9.5 | Not used |
| For scale: keyword count, no model | | | | | 8 | 27 | 35 | | The fallback an AI already has |
| For scale: BM25, no model | | | | | 15 | 30 | 45 | | Best-case keyword search |

**Two rows record what we observed on Oct 6, 2026 with `ruvector` 0.3.3 on this machine,** and nothing more than that. With bge-base-en-v1.5, the worker pool returned 384 numbers per passage where 768 were expected; on a single thread the model ran. For e5-small-v2, the address the library downloads from returned 404. We did not look into the cause of either. Not yet reported upstream; we will.

**Why all-MiniLM-L6-v2 is the default.** It is the smallest download and the fastest, about twice as fast as the next group, and no other model did better on this set by a margin worth its cost. The best other score was 43 of 60 against 42. Question by question, gte-small found 9 that the default missed and the default found 8 that gte-small missed. It is also ruvector's own default.

**gte-small is the one alternative worth a look.** It scored highest on exact phrases (24 against 20) and lower on reworded questions (19 against 22). Neither gap is outside the noise of a set this size, so that is a lean and not a finding. It costs a 134 MB download and a first sync about twice as long. It is not in the tool's model table, because it has not been run inside the tool.

**The keyword rows are there for scale.** The reworded questions avoid the note's own words, which is the worst case for keyword search, and the exact questions quote the note, which is the best case. So those rows show what each method is for, not which is better. Keyword search found more of the exact questions than any model did, and that is why a search also returns an exact-words list and why the rule `init` writes sends an AI to the files when the passages do not answer.

**How far to trust this.** In a set of 60, one question is under 2 points, and 42 of 60 means the true rate is somewhere between about 57% and 80%. A real difference of 10 points between two models, in either direction, could hide here. So the finding is "no large gain from any other model", not "the models are equally good". **Not a number to print**, as with every recall figure in this file.

The speed column is from the study's harness. The tool's own pipeline reads the practice vault at about 36 passages a second with 4 readers (see the budget table above), with its own smaller passages.

## Measured again for the README

Same machine and versions, Oct 6, 2026, on branch `feat/exact-words`, practice vault (176 notes, 2,199 passages). Fewer jobs were running than for the tables above, but the machine was not idle: the load average was 4.6 when the first sync started and 5.7 to 6.0 for everything after it. Each repeated command was run 7 times, a cold process each time; the range is written out.

| Operation | Measured | Load average |
| --- | --- | --- |
| First sync, 4 readers, low priority (the tool's default) | 60.1 s for 2,199 passages; 214.8 CPU-seconds; peak memory 1.85 GB | 4.6 at the start, 6.0 at the end |
| Sync with nothing changed | 0.04 to 0.05 s | 6.0 |
| `status` | 0.11 to 0.12 s | 6.0 |
| Search, one wording | 0.36 to 0.37 s | 6.0 |
| Search, one wording, `--no-sync` | 0.36 to 0.37 s | 5.8 |
| Search, three wordings in one call | 0.36 to 0.38 s | 5.8 |
| Sync after one edited note (one run) | 1.06 s | 5.7 |
| `status --verify` (one run) | 0.33 s | 5.7 |
| `rebuild` (one run) | 0.14 s | 5.7 |
| Peak memory, search; `status` (one run each) | 0.71 GB; 0.07 GB | 5.7 |
| Index folder on disk | 13 MB (8.5 MB engine file, 4.1 MB sidecar, 0.26 MB exact-words table) | |

The tool's own breakdown of one of those searches (`--no-sync`): model load and question 0.255 s, opening the engine 0.031 s (the probe child took 0.216 s alongside the model load), search 0.002 s, exact-words list 0.002 s, reading passages back 0.001 s.

The README's first-run example and its demo recording use the invented fixture vault cut down to its plain folders (15 notes that belong in the index, 32 passages): the first sync took 2.0 to 2.2 s in each of five runs, and a search with one wording 0.29 s by the tool's own count.

An independent re-run of this section on Oct 7, 2026 (same machine, fresh copy of the practice vault, load average about 8): first sync 60.9 s, search 0.40 s, `status` 0.12 s, peak memory for the first sync 1.95 GB, index folder 14 MB by `du`.

## A real vault of about two thousand notes

One run, Oct 6, 2026, same machine and versions, on commit `cbac564` (before the exact-words list was added). The vault is a real personal vault. It is private and not in this repo, so a reader cannot repeat this run; the commands were the ordinary ones (`init`, `sync`, `status`, `search`). The sync ran at low priority with 6 readers. The load average was about 7 to 9, so every speed here is **busy** and rough.

| What | Measured |
| --- | --- |
| Notes | 2,092 `.md` files on disk; 2,082 indexed (the 10 in the templates folder are left out by default) |
| Passages | 51,572 |
| First sync, 6 readers, low priority | 17 min 7 s: about 50 passages a second |
| Peak memory, first sync | about 2.7 GB (the 2 GB budget is for 4 readers) |
| Index folder on disk | 218 MB |
| Search, cold process, one wording | 0.48 to 0.49 s: model load and question 0.26 s, opening the index 0.17 s, the search itself 0.016 s |
| `status` | 0.26 s |
| Sync with nothing changed | 0.06 s |
| 1:1 check | Passed: notes on disk that belong = notes in the index; passages recorded = passages in ruvector |
| Read-only check | A checksum listing of the vault before and after the run was identical |

Not measured in this run: a sync after one edit, three wordings in one call, `rebuild`, peak memory for a search, and anything with the exact-words list. The scale check above covers those with synthetic vectors.

## Items the spec listed as "not measured by anything yet"

| Item | State after this build |
| --- | --- |
| Passage count this chunker gives the reference vault | 51,572 passages from 2,082 notes (see "A real vault of about two thousand notes") |
| The flat index with real vectors | Measured at 641 and 2,199 real vectors: every passage id present, and 50 of 50 sampled searches equal an exact scan (`status --verify`). At 40,000 rows only synthetic vectors were used (50 of 50) |
| End-to-end rate through this tool's own pipeline | 36 to 37 passages a second with 4 readers at low priority (busy) |
| First-sync time on an ordinary laptop | **Still owed.** One machine only |
| Crash safety of the sidecar | `kill -9` in the middle of a first sync, then `sync` again: the second run embedded only the remainder, totals matched an uninterrupted sync, and `status --verify` was in step (acceptance step 14, passed on every run). One kill point per run |
| Stopping with Ctrl-C | Exit 130 about 3 s after the signal, with "Run it again to continue"; the next sync finished the rest (step 15) |
| A sync paused for 150 s while a second one waits | The second never took over; it ran afterwards and found nothing to do (step 16) |
| Pool behaviour after a timeout | Only with a fake pool in unit tests: a pool error discards the pool, a second one finishes with one reader. **Not provoked on a real pool** |
| Installing from git | **Measured from a local commit; the public tag is still owed** (there is no public tag yet). `npm install -g --prefix <temp folder> git+file://<this repo>#df9b6be`, the same git route npm takes for `github:HeroForgeAI/vault-mirror#v0.1.0`: 162 packages added, 67 MB on disk, no install script run. That copy's `doctor` showed the three pinned versions loaded, and its `init`, `sync`, `search` and `status` ran on the fixture vault and ended in step. An earlier stand-in (`npm pack`, then installing the tarball) passed acceptance steps 1 to 5 |
| An interrupted or poisoned model download, end to end | **Still owed.** The translation of the library's two raw errors is unit-tested with a fake library; no real download was interrupted, because the model cache is shared with other tools on this machine |
| Any machine other than the build machine | **Numbers still owed.** Every number in this file is from one Apple Silicon Mac. Since 0.1.1 the commands themselves are tested on CI on macOS, Windows and Linux (x64 hosted machines, vaults of about 170 notes); nothing was timed there for this file. Intel Macs, Windows on ARM and Linux on ARM are not yet verified |
| Whether an `obsidian://` link opens when clicked | **Still owed.** It needs a person. The format is unit-tested and round-trips |
| The token counter against the real model | Agreed at the exact edge of the window for 22 kinds of text (prose, prices, hex, web addresses, accents, emoji, Greek, Cyrillic, Japanese, CJK, symbols, zero-width and no-break spaces, a 120-character word). The window test passed 200 of 200 on the practice vault (densest passage 110 tokens) and 200 of 200 on the fixture |
| How often the index finds the right note for a question asked in other words | Ten reworded questions on the practice vault: the expected note was in the top 3 for 9 of 10 with one wording, and for 10 of 10 (rank 1 or 2) when three wordings were passed in one call. Two runs agreed on all ten. A small sample from one author: recorded, **not a number to print**. Run again with the exact-words list: the same counts, see "The recall check" above |

## How to measure again

```bash
npm test
node tests/acceptance/run.mjs --vault tests/fixtures/vault
node tests/acceptance/run.mjs --vault <a vault> --read-only-vault --questions tests/acceptance/questions.obsidian-help.json
node tests/bench/scale.mjs --dir <an empty scratch folder>
node tests/bench/scale.mjs --dir <an empty scratch folder> --notes 2000 --passages 50000 --runs 7
```

Run them with nothing else heavy on the machine, and write the load average beside each number.
