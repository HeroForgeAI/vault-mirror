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

## The blended list

Measured Oct 7, 2026 on branch `feat/hybrid-search`, same machine and versions as above. Load average is written beside each run; none was taken on a quiet machine. Speed aside, these counts do not depend on load: the same questions give the same lists every time.

**What changed.** A search used to print two lists that were never mixed: the best 8 notes by meaning, then up to 3 passages that hold the question's exact words. It now prints one ranked list, then the same short exact-words list for whatever the first list did not show. `--no-blend` (or `"blend": false` in the settings) gives the two lists as before, byte for byte.

**How the one list is ordered.** Every passage keeps its match by meaning (the `match` number, 0 to 1). A passage that holds more than half of the question's distinctive words gains a bonus on top:

- **Share.** Which of the question's distinctive words the passage holds, each word weighted by how rare it is in the vault (the same rarity weight the exact-words list uses). It counts whether a word is there, not how often. 0 to 1.
- **Bonus.** Nothing up to a share of 0.5, then a straight line up to 0.20 at a share of 1.
- **Standing out.** The full bonus goes to at most 3 notes. When more notes hold the words at least as fully, each gains 3 / that many of its bonus. Words that twenty notes hold equally tell nothing apart, so they move nothing.
- **Order.** Match plus bonus, then match, then path. A note is listed once, by its highest passage.

The three numbers (0.5, 0.20, 3) are in `src/search/blend.js`. No model is involved, and a search with the blend took 1 to 4 ms longer than one without (below).

### The questions, and how they were made

All on the practice vault (176 notes, 2,199 passages), which a reader can rebuild.

- **Set A** (120 questions) and **set B** (120 questions): `tests/bench/questions.obsidian-help.a.json` and `.b.json`. Notes of 150 words or more were put in order of the SHA-256 of their vault path; set A is about the first 40, set B about the next 40. For each note there are three questions: **close** (a natural question that shares a few words with the note), **far** (no distinctive word of the question appears anywhere in the note or its file name) and **exact** (a name, a setting label, a code or a short phrase taken from the note word for word). Each has two more wordings of the kind an AI writes before it searches.
- **The older 20**: `tests/acceptance/questions.obsidian-help.json`, ten **reworded** questions and ten in the note's **own words**, from the recall check above.

Sets A and B were each written by an AI agent that was given the notes and the three definitions and nothing else: it did not know how the tool ranks or what was being compared, and the writer of set B was told not to look at set A. `ranking.mjs --check <vault>` confirms by script that all 80 far questions share no distinctive word with their note and that all 80 exact lookups are in their note word for word.

**Set A and the older 20 shaped the design; set B judged it.** The three numbers above were chosen while looking at set A and the older 20. They were then frozen in a commit, set B was written after that commit, and set B was run once. Read the set A tables as a description and the set B tables as the test.

A question counts at the place of the first right note (the expected note or a listed alternate) in what a search prints: the 8 results, then the exact-words list. "Printed" means anywhere in that output. MRR@10 and nDCG@10 are taken over the first ten places of the same output.

### Set B: the test (120 questions, run once; load average 4.1)

`VAULT_MIRROR_HOME=<home> node tests/bench/ranking.mjs --questions tests/bench/questions.obsidian-help.b.json --check <the vault>`

One wording:

| Kind | Method | Top 1 | Top 3 | Top 5 | Top 8 | Printed | MRR@10 | nDCG@10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Close (40) | two lists | 36 | 39 | 39 | 39 | 40 | 0.932 | 0.941 |
| Far (40) | two lists | 17 | 27 | 31 | 34 | 34 | 0.565 | 0.624 |
| Exact (40) | two lists | 27 | 32 | 34 | 36 | 40 | 0.764 | 0.808 |
| All (120) | two lists | 80 | 98 | 104 | 109 | 114 | 0.754 | 0.791 |
| Close (40) | blended | 37 | 40 | 40 | 40 | 40 | 0.963 | 0.965 |
| Far (40) | blended | 17 | 27 | 31 | 34 | 34 | 0.565 | 0.624 |
| Exact (40) | blended | 37 | 39 | 39 | 39 | 40 | 0.949 | 0.959 |
| All (120) | blended | 91 | 106 | 110 | 113 | 114 | 0.826 | 0.849 |
| Close (40) | plain rank fusion | 36 | 39 | 39 | 40 | 40 | 0.942 | 0.947 |
| Far (40) | plain rank fusion | 0 | 2 | 3 | 6 | 6 | 0.036 | 0.049 |
| Exact (40) | plain rank fusion | 30 | 36 | 38 | 39 | 39 | 0.838 | 0.867 |
| All (120) | plain rank fusion | 66 | 77 | 80 | 85 | 85 | 0.605 | 0.621 |

Three wordings in one call:

| Kind | Method | Top 1 | Top 3 | Top 5 | Top 8 | Printed | MRR@10 | nDCG@10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Close (40) | two lists | 34 | 38 | 39 | 39 | 40 | 0.905 | 0.925 |
| Far (40) | two lists | 30 | 39 | 40 | 40 | 40 | 0.865 | 0.889 |
| Exact (40) | two lists | 32 | 37 | 39 | 40 | 40 | 0.871 | 0.898 |
| All (120) | two lists | 96 | 114 | 118 | 119 | 120 | 0.880 | 0.904 |
| Close (40) | blended | 34 | 40 | 40 | 40 | 40 | 0.925 | 0.942 |
| Far (40) | blended | 31 | 40 | 40 | 40 | 40 | 0.879 | 0.900 |
| Exact (40) | blended | 38 | 40 | 40 | 40 | 40 | 0.975 | 0.981 |
| All (120) | blended | 103 | 120 | 120 | 120 | 120 | 0.926 | 0.941 |
| Close (40) | plain rank fusion | 36 | 39 | 40 | 40 | 40 | 0.944 | 0.958 |
| Far (40) | plain rank fusion | 34 | 40 | 40 | 40 | 40 | 0.921 | 0.926 |
| Exact (40) | plain rank fusion | 34 | 39 | 39 | 40 | 40 | 0.917 | 0.941 |
| All (120) | plain rank fusion | 104 | 118 | 119 | 120 | 120 | 0.927 | 0.942 |

### Set A and the older 20: what the design was shaped on (140 questions; load average 4.5)

`VAULT_MIRROR_HOME=<home> node tests/bench/ranking.mjs --questions tests/bench/questions.obsidian-help.a.json --questions tests/acceptance/questions.obsidian-help.json`

One wording:

| Kind | Method | Top 1 | Top 3 | Top 5 | Top 8 | Printed | MRR@10 | nDCG@10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Close (40) | two lists | 38 | 40 | 40 | 40 | 40 | 0.971 | 0.970 |
| Far (40) | two lists | 16 | 29 | 31 | 31 | 31 | 0.549 | 0.604 |
| Exact (40) | two lists | 25 | 32 | 35 | 36 | 40 | 0.726 | 0.782 |
| Reworded (10) | two lists | 7 | 9 | 9 | 9 | 9 | 0.800 | 0.826 |
| Own words (10) | two lists | 5 | 9 | 9 | 10 | 10 | 0.714 | 0.786 |
| All (140) | two lists | 91 | 119 | 124 | 126 | 130 | 0.750 | 0.788 |
| Close (40) | blended | 39 | 40 | 40 | 40 | 40 | 0.988 | 0.981 |
| Far (40) | blended | 16 | 29 | 31 | 31 | 31 | 0.549 | 0.604 |
| Exact (40) | blended | 35 | 38 | 40 | 40 | 40 | 0.925 | 0.941 |
| Reworded (10) | blended | 7 | 9 | 9 | 9 | 9 | 0.800 | 0.826 |
| Own words (10) | blended | 7 | 10 | 10 | 10 | 10 | 0.850 | 0.889 |
| All (140) | blended | 104 | 126 | 130 | 130 | 130 | 0.821 | 0.844 |
| Close (40) | plain rank fusion | 37 | 40 | 40 | 40 | 40 | 0.958 | 0.964 |
| Far (40) | plain rank fusion | 0 | 0 | 0 | 3 | 3 | 0.013 | 0.023 |
| Exact (40) | plain rank fusion | 32 | 37 | 38 | 40 | 40 | 0.867 | 0.894 |
| Reworded (10) | plain rank fusion | 6 | 8 | 8 | 9 | 9 | 0.696 | 0.732 |
| Own words (10) | plain rank fusion | 5 | 9 | 10 | 10 | 10 | 0.725 | 0.780 |
| All (140) | plain rank fusion | 80 | 94 | 96 | 102 | 102 | 0.627 | 0.646 |

Three wordings in one call:

| Kind | Method | Top 1 | Top 3 | Top 5 | Top 8 | Printed | MRR@10 | nDCG@10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Close (40) | two lists | 39 | 40 | 40 | 40 | 40 | 0.988 | 0.979 |
| Far (40) | two lists | 31 | 36 | 40 | 40 | 40 | 0.860 | 0.884 |
| Exact (40) | two lists | 34 | 37 | 38 | 38 | 40 | 0.899 | 0.918 |
| Reworded (10) | two lists | 9 | 10 | 10 | 10 | 10 | 0.950 | 0.963 |
| Own words (10) | two lists | 8 | 10 | 10 | 10 | 10 | 0.900 | 0.926 |
| All (140) | two lists | 121 | 133 | 138 | 138 | 140 | 0.917 | 0.929 |
| Close (40) | blended | 40 | 40 | 40 | 40 | 40 | 1.000 | 0.990 |
| Far (40) | blended | 35 | 38 | 40 | 40 | 40 | 0.924 | 0.934 |
| Exact (40) | blended | 37 | 38 | 39 | 40 | 40 | 0.946 | 0.956 |
| Reworded (10) | blended | 9 | 10 | 10 | 10 | 10 | 0.950 | 0.963 |
| Own words (10) | blended | 10 | 10 | 10 | 10 | 10 | 1.000 | 1.000 |
| All (140) | blended | 131 | 136 | 139 | 140 | 140 | 0.959 | 0.963 |
| Close (40) | plain rank fusion | 38 | 40 | 40 | 40 | 40 | 0.975 | 0.975 |
| Far (40) | plain rank fusion | 34 | 38 | 39 | 40 | 40 | 0.901 | 0.915 |
| Exact (40) | plain rank fusion | 37 | 38 | 38 | 39 | 39 | 0.942 | 0.947 |
| Reworded (10) | plain rank fusion | 9 | 9 | 9 | 10 | 10 | 0.917 | 0.936 |
| Own words (10) | plain rank fusion | 10 | 10 | 10 | 10 | 10 | 1.000 | 1.000 |
| All (140) | plain rank fusion | 128 | 135 | 136 | 139 | 139 | 0.942 | 0.949 |

### What the tables say

- **On every kind of question, in both sets, with one wording and with three, the blended list was at least as good as the two lists in every column**, and better overall: on set B the first place went from 80 to 91 of 120 with one wording and from 96 to 103 with three; MRR@10 from 0.754 to 0.826 and from 0.880 to 0.926. That is the bar that was set before the default could change, so the blended list is the default.
- **The gain is in exact lookups.** With one wording the right note was first for 27 of 40 exact lookups before and 37 after (set B). A name or a code used to be found in the second list; now it is at the top of the first.
- **A far question with one wording is not helped.** Those rows are the same before and after, to the last digit. A note that shares no word with the question has no exact words to be found by, and the blend is built to leave such a search alone. Several wordings in one call are still what helps there.
- **Single questions did move down.** Blended against two lists, the right note moved up in 30 searches and down in 8 on set B (36 and 3 on set A and the older 20), each time by one to three places and never out of the printed output. The script lists each one.
- **Plain rank fusion was tried first and not kept.** It gives every note 1 / (60 + its place) from each list and adds the two, the usual way to merge two rankings. With one far wording the right note was first for none of 40 questions in either set, and in the top 8 for 3 and 6 of 40, against 31 and 34 by meaning alone. The reason is simple: on a vault this size nearly every note is somewhere in both lists, the right note of a far question is in one list only by construction, and a note that is in both lists at any place outranks a note that is first in one. With three wordings it did about as well as the blend (MRR@10 0.927 against 0.926 on set B, 0.942 against 0.959 on set A and the older 20). A method that fails one common case that badly cannot be a default.

### Speed

Cold start, `search --no-sync --json`, median of 9, practice vault, load average 4.9:

| Search | Two lists (`--no-blend`) | Blended |
| --- | --- | --- |
| One wording | 0.357 s | 0.359 s |
| Three wordings | 0.385 s | 0.392 s |
| The exact-words part of that (`timings.wordsMs`) | 2 ms | 3 ms one wording, 6 ms three |
| Peak memory | 0.68 GB | 0.59 to 0.68 GB (the same within what one run varies) |

Scale check (`tests/bench/scale.mjs --notes 2000 --passages 50000 --runs 7`, synthetic vectors, load average 5.8): one wording 0.503 s blended and 0.496 s with `--no-blend`; the exact-words part 19 ms and 18 ms; three wordings 0.541 s blended; peak memory 0.84 GB, as before. Warm, inside one process (`ranking.mjs`, which calls `searchReady` directly): 96.7 ms against 95.8 ms per question with one wording and 286.8 against 285.5 ms with three, nearly all of it embedding the question.

### A second pass with another model: measured, not built in

Other tools score the top results again with a second model that reads the question and the passage together (often called reranking). This was measured before deciding, and it is **not in vault-mirror**: on these questions it made the list worse, and it needs a second runtime.

**Can it run on what the tool already has? No.** ruvector 0.3.3 ships one model runner, for embedding models. Given a small model of this kind (ms-marco-TinyBERT-L2-v2, 17.6 MB) it either stops with an error (CLS pooling) or returns 384 zeros (mean pooling): it expects a grid of numbers per token, and such a model returns one number. ruvector's package also holds no code that merges two rankings or scores a pair. So a second pass needs its own runtime: `onnxruntime-node` 1.30.0 is 287 MB installed for every platform together (85 MB of it is the macOS arm64 build) and has builds for macOS arm64, Linux x64 and arm64 and Windows x64 and arm64, with none for Intel Macs; `onnxruntime-web` (WebAssembly, any platform) is 145 MB. Today the whole of vault-mirror installs at about 67 MB.

**Three small models were tried**, each over the top 20 passages of the blended list, the question's first wording against each passage, 2 threads:

| Model | Download | Extra memory once loaded | Time per question, 20 passages (median) | Needs |
| --- | --- | --- | --- | --- |
| cross-encoder/ms-marco-MiniLM-L6-v2 | 91.0 MB | about 170 to 180 MB | 75 to 78 ms | the runtime; its scores matched the two on its model page to six digits |
| jinaai/jina-reranker-v1-tiny-en | 132.4 MB | about 305 MB | 62 to 63 ms | the runtime and a second tokenizer (`@huggingface/tokenizers`, 0.4 MB); not checked against a reference score |
| cross-encoder/ms-marco-TinyBERT-L2-v2 | 17.6 MB | about 60 MB | 8 ms | the runtime |

Loading the runtime and opening the 91 MB model took about 60 ms in a fresh process. Machine: Apple M4 Max; a laptop with fewer and slower cores will take longer per question.

"Second pass" puts the 20 passages in the second model's order and prints the first 8. "Mixed by place" keeps more of the first order near the top (three quarters of the weight in places 1 to 3, less further down), the shape qmd describes. MRR@10 by kind; every other column is printed by the script.

Set B (the test):

| Model | Wordings | Method | Close MRR@10 | Far MRR@10 | Exact MRR@10 | All MRR@10 | All, top 5 | All, nDCG@10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| (no second pass) | one | blended | 0.963 | 0.565 | 0.949 | 0.826 | 110 of 120 | 0.849 |
| ms-marco-MiniLM-L6-v2 | one | second pass | 0.902 | 0.251 | 0.988 | 0.714 | 98 of 120 | 0.742 |
| ms-marco-MiniLM-L6-v2 | one | second pass, mixed by place | 0.963 | 0.530 | 0.963 | 0.818 | 108 of 120 | 0.835 |
| (no second pass) | three | blended | 0.925 | 0.879 | 0.975 | 0.926 | 120 of 120 | 0.941 |
| ms-marco-MiniLM-L6-v2 | three | second pass | 0.867 | 0.313 | 0.926 | 0.702 | 104 of 120 | 0.752 |
| ms-marco-MiniLM-L6-v2 | three | second pass, mixed by place | 0.921 | 0.859 | 0.975 | 0.918 | 120 of 120 | 0.931 |
| jina-reranker-v1-tiny-en | one | second pass | 0.912 | 0.221 | 0.963 | 0.699 | 94 of 120 | 0.725 |
| jina-reranker-v1-tiny-en | one | second pass, mixed by place | 0.963 | 0.532 | 0.963 | 0.819 | 110 of 120 | 0.836 |
| jina-reranker-v1-tiny-en | three | second pass | 0.842 | 0.246 | 0.912 | 0.667 | 96 of 120 | 0.702 |
| jina-reranker-v1-tiny-en | three | second pass, mixed by place | 0.925 | 0.851 | 0.975 | 0.917 | 120 of 120 | 0.931 |
| ms-marco-TinyBERT-L2-v2 | one | second pass | 0.887 | 0.143 | 0.975 | 0.668 | 89 of 120 | 0.688 |
| ms-marco-TinyBERT-L2-v2 | one | second pass, mixed by place | 0.963 | 0.517 | 0.963 | 0.814 | 108 of 120 | 0.828 |
| ms-marco-TinyBERT-L2-v2 | three | second pass | 0.817 | 0.219 | 0.929 | 0.655 | 95 of 120 | 0.688 |
| ms-marco-TinyBERT-L2-v2 | three | second pass, mixed by place | 0.921 | 0.847 | 0.975 | 0.914 | 120 of 120 | 0.928 |

Set A and the older 20 (taken before one word of one far question in set A was changed; the blended rows were run again afterwards and did not move, the second-pass rows were not run again):

| Model | Wordings | Method | Close MRR@10 | Far MRR@10 | Exact MRR@10 | Reworded MRR@10 | Own words MRR@10 | All MRR@10 | All, top 5 | All, nDCG@10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| (no second pass) | one | blended | 0.988 | 0.549 | 0.925 | 0.800 | 0.850 | 0.821 | 130 of 140 | 0.844 |
| ms-marco-MiniLM-L6-v2 | one | second pass | 0.938 | 0.253 | 0.988 | 0.482 | 0.883 | 0.720 | 116 of 140 | 0.756 |
| ms-marco-MiniLM-L6-v2 | one | second pass, mixed by place | 0.988 | 0.523 | 0.938 | 0.767 | 0.850 | 0.815 | 129 of 140 | 0.836 |
| (no second pass) | three | blended | 1.000 | 0.924 | 0.946 | 0.950 | 1.000 | 0.959 | 139 of 140 | 0.963 |
| ms-marco-MiniLM-L6-v2 | three | second pass | 0.896 | 0.339 | 0.950 | 0.560 | 0.670 | 0.712 | 120 of 140 | 0.752 |
| ms-marco-MiniLM-L6-v2 | three | second pass, mixed by place | 1.000 | 0.918 | 0.956 | 0.933 | 1.000 | 0.959 | 139 of 140 | 0.962 |
| jina-reranker-v1-tiny-en | one | second pass | 0.855 | 0.194 | 0.958 | 0.520 | 0.950 | 0.679 | 107 of 140 | 0.709 |
| jina-reranker-v1-tiny-en | one | second pass, mixed by place | 0.983 | 0.509 | 0.931 | 0.800 | 0.850 | 0.810 | 128 of 140 | 0.834 |
| jina-reranker-v1-tiny-en | three | second pass | 0.850 | 0.252 | 0.917 | 0.376 | 0.745 | 0.657 | 105 of 140 | 0.701 |
| jina-reranker-v1-tiny-en | three | second pass, mixed by place | 1.000 | 0.917 | 0.956 | 0.933 | 1.000 | 0.959 | 139 of 140 | 0.959 |
| ms-marco-TinyBERT-L2-v2 | one | second pass | 0.926 | 0.178 | 0.929 | 0.283 | 0.883 | 0.664 | 109 of 140 | 0.698 |
| ms-marco-TinyBERT-L2-v2 | one | second pass, mixed by place | 0.988 | 0.510 | 0.931 | 0.767 | 0.850 | 0.809 | 128 of 140 | 0.836 |
| ms-marco-TinyBERT-L2-v2 | three | second pass | 0.885 | 0.240 | 0.900 | 0.329 | 0.720 | 0.653 | 111 of 140 | 0.692 |
| ms-marco-TinyBERT-L2-v2 | three | second pass, mixed by place | 1.000 | 0.912 | 0.950 | 0.933 | 1.000 | 0.956 | 139 of 140 | 0.959 |

- **The second pass alone made the list much worse** with every model: overall MRR@10 fell from 0.826 to between 0.668 and 0.714 with one wording on set B, and from 0.926 to between 0.655 and 0.702 with three. Far questions fell furthest (0.565 to 0.143 to 0.251). These small models were trained on web search questions and lean on shared words even more than the reading model does.
- **It helped only exact lookups with one wording** (0.949 to between 0.963 and 0.988), where the blend had already taken most of the gain.
- **Mixed by place it was about even, a little below** (0.814 to 0.819 against 0.826; 0.914 to 0.918 against 0.926).
- So there is no setting to turn it on. A larger model might do better (qmd's is about 640 MB); none was tried, because a download of that size is outside what this tool asks of a person.

How to repeat it is at the top of `tests/bench/second-pass.mjs`. The models and the runtime were downloaded to a scratch folder and deleted afterwards.

### Limits

- One vault of 176 notes, in English, about one subject, and questions written by an AI that had read the notes. With 40 questions of a kind, one question is 2.5 points. **Not numbers to print**, as with every figure in this file.
- A far question here shares no word at all with its note, which is harder than most real questions; an exact lookup here is 2 to 6 words, which is the easy case for exact words. Real questions sit between the two.
- The three numbers in the blend were chosen on one vault. Set B says they hold on other notes of the same vault. Nothing here says they are the best numbers for another vault, another language or a much larger one. The private vault of 2,082 notes in the section above was not used: its questions are not in this repo.
- A right note in the list does not mean the passage shown answers the question.

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
VAULT_MIRROR_HOME=<a home whose vault is the practice vault> node tests/bench/ranking.mjs --questions tests/bench/questions.obsidian-help.b.json --check <the vault>
```

Run them with nothing else heavy on the machine, and write the load average beside each number.
