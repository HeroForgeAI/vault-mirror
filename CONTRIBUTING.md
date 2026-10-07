# Contributing to vault-mirror

**The short version.** Ideas and fixes are welcome. Everything comes in as a pull request from your own fork. Automated checks run on it, and Mak Allen approves it before it merges.

You do not need to be a programmer to help. A clear bug report, a confusing sentence you spotted, or a note that it worked (or did not) on your computer are all real contributions.

This is a small tool with a narrow promise: keep one vault and one local index in step, and only ever read the notes. The most useful contributions keep it that way.

## Before anything else: never share your notes

An index folder holds a plain-text copy of your notes. **Never attach notes, an index folder, `passages.jsonl` or `manifest.json` to an issue or pull request.** What is safe to share:

- the output of `vault-mirror status` and `vault-mirror doctor` (counts and versions only);
- `logs/sync.log` and `logs/debug.log` from the index folder. By design they hold no note text, no note names and no search questions.

If a bug needs a note to reproduce it, write a small invented one.

## Where to ask a question

Open an issue and pick **A question, or help getting set up**. No question is too basic. Run `vault-mirror doctor` first if you can, and paste what it prints.

## Reporting a bug

Open an issue with the bug form. It asks for your version (`vault-mirror --version`), operating system, Node version, the command you ran, and what `status` and `doctor` print. Reports from Intel Macs, Windows on ARM and Linux on ARM are especially welcome: those are not yet verified. So are reports from large vaults on Windows and Linux, which are tested on CI with small vaults only.

Security problems are different. They go through [SECURITY.md](SECURITY.md), which is private, and never into a public issue.

## Proposing a change

For a typo or a small fix, go straight to a pull request.

For anything bigger, **open an issue first** and describe the change in two sentences. That way you hear "yes", "not like that" or "no" before you have spent an evening on it.

## Making the change

1. **Fork** the repo on GitHub. Nobody can push straight to this repo's main branch, so your fork is where your work lives.
2. **Branch** from `main` in your fork.
3. **Set up:**

   ```bash
   git clone https://github.com/<your-name>/vault-mirror.git
   cd vault-mirror
   npm ci            # never --omit=optional: the native engine is an optional package
   ```

   Node 20 or newer. There is no build step.
4. **Change** one thing.
5. **Run the checks:**

   ```bash
   npm test                 # unit tests: no network, a few seconds
   npm run typecheck        # tsc --noEmit over the JSDoc types
   npm run lint             # eslint
   npm run acceptance       # end to end on the invented fixture vault: a few minutes, needs the reading model
   ```

   The first three are expected to pass on your machine. Run `acceptance` too for any change under `src/`. It copies the fixture vault to a temp folder, runs the real binary against it, and compares a checksum listing of the vault after every command. It uses its own home folder, so your own index stays out of it; set `VAULT_MIRROR_TEST_TMP` to choose where. It is verified on Apple Silicon Macs only. If it fails on your platform, say so in the pull request and paste the failing step.
6. **Open a pull request** against `main`. The template has a short checklist. Fill it in.

## What a good pull request looks like

- **One change.** Two fixes are two pull requests.
- **A test** that fails without your change.
- **A plain commit message** that says what changed.
- **One line in `CHANGELOG.md`** under **Unreleased**.
- **No real notes** anywhere: not in the diff, the fixtures or the description.

## What happens next

1. **CI runs** your branch on macOS, Linux and Windows. If this is your first pull request here, the run waits for a maintainer to click "approve". That is a safety step GitHub applies to new contributors, not a judgment of your work.
2. **A maintainer reviews it**, usually within a few days. Expect questions or requested changes. That is normal.
3. **Mak Allen approves and merges it** as one squashed commit. Every merge needs his approval. If you push again after he has said yes, the new version is looked at again before it merges.

A pull request that goes quiet gets a polite nudge after two weeks and is closed after four, with an invitation to reopen it. See [GOVERNANCE.md](GOVERNANCE.md).

## Who decides

The two maintainers: Mak Allen ([@HF-teamdev](https://github.com/HF-teamdev)) and Mark Allen ([@mamd69](https://github.com/mamd69)). Either may review and ask for changes. Mak's approval is the one a merge needs. They may say no. When they do, it will be kind and it will come with a reason.

## The hard lines

No pull request may cross these, however good the rest of it is.

1. **The tool never writes, moves or deletes anything inside a vault.**
2. **It makes no network request**, except the one-time download of the reading model.
3. **No telemetry.** Nothing is counted, reported or phoned home.
4. **No new runtime dependency without an issue first.** There are two today: `ruvector`, and `@modelcontextprotocol/server` (the official MCP SDK, loaded only by `vault-mirror mcp`).
5. **The pinned `ruvector` version changes only through the maintainers' check.** Every index depends on that exact version's behaviour, so a maintainer bumps it by hand after the flat-index self-test and the full acceptance run. The upgrade gate is described in [`docs/SPEC.md`](docs/SPEC.md). A pull request that moves the pin or its shrinkwrap entries will be closed.
6. **Tests use invented notes only.** Never anyone's real notes, and never pages copied from a documentation site.
7. **Messages a user sees stay in plain words, with one next action.**
8. **No background process is ever started unless the user turns one on.** The MCP server is one the user adds to an app. Its reader lives only while that app keeps the server open, and stops after a few idle minutes.
9. **The MCP server gets no tool that writes to a vault.** No tool that takes a path or text to save, and no tool that creates, edits, moves or deletes a note.

## How the code keeps them

These are checked by tests, so a pull request that breaks one will fail.

- **The vault is only ever read.** `src/vault/read-only-fs.js` is the only module that touches vault paths, and it can only list, stat and read. `src/store/safe-write.js` is the only module that writes, renames or deletes, and it refuses any path inside a vault.
- **The chunker is a pure function and is versioned.** Any change to what `src/chunker/` produces bumps `CHUNKER_VERSION` in `src/version.js`, because it makes every user re-read every note once. Say so in the changelog.
- **Model names and vector sizes stay inside `src/embed/`. Engine details stay inside `src/engine/`.**
- **Every error is one plain sentence and one next action.** Wording lives in `src/errors.js`.
- **Fixtures are invented.** They live in `tests/fixtures/`.
- **No claim without a measurement.** A number in the README or docs comes from a command in [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md), with its conditions.

The design and the reasons behind it are in [`docs/SPEC.md`](docs/SPEC.md).

## What fits, and what does not

Fits: correctness of the 1:1 sync, the read-only guarantee, clearer messages, platform fixes, tests, measured speed-ups.

Does not fit: anything across a hard line above, a background watcher that is on by default, a hosted service.

## Licensing

vault-mirror is released under the [MIT license](LICENSE). Contributions come in under that same license. There is no contributor agreement to sign. **By opening a pull request you agree that your contribution is released under the MIT license in this repo**, and that it is yours to give.

## Releases

Only Mak Allen tags and releases. People install a pinned tag, so **a published tag is never moved**. A fix ships as a new version.

## Conduct

Be kind and patient. The [Code of Conduct](CODE_OF_CONDUCT.md) applies everywhere in this project.

## Re-recording the demo

```bash
bash docs/demo/setup.sh    # builds a throwaway sandbox from the fixture vault
vhs docs/demo/demo.tape    # writes docs/demo/demo.gif
node scripts/make-dark-svg.mjs   # after editing a *-light.svg in docs/assets
```
