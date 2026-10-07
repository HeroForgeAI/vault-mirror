# Governance

How decisions are made in vault-mirror. It fits on one screen on purpose.

## Maintainers

- Mak Allen ([@HF-teamdev](https://github.com/HF-teamdev))
- Mark Allen ([@mamd69](https://github.com/mamd69))

They are the only people who can merge, tag or release. Nobody else has write access.

## What they decide

What goes into the tool, what stays out, when a version ships, and whether a change crosses one of the hard lines in [CONTRIBUTING.md](CONTRIBUTING.md). They may say no. When they do, it is kind and it comes with a reason.

## How a change gets merged

1. It arrives as a pull request. Nothing is pushed straight to `main`, by anyone.
2. Mak Allen approves it. Every merge needs his approval, whoever opened the pull request. He says so on the pull request or merges it himself; the repository's rules require the pull request and the passing checks, and his yes is what lets it merge.
3. The required checks are green.
4. It is squash merged: one pull request becomes one commit on `main`.

A maintainer's own pull request goes through the same checks. Mark Allen's pull requests need Mak's approval like anyone else's. Mak's own pull requests still go through a pull request and the automated checks before he merges them.

## Releases

Only Mak Allen tags and releases. Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html), and every release has an entry in [CHANGELOG.md](CHANGELOG.md). A published tag is never moved or deleted, because people install a pinned tag. A fix ships as a new version.

## Becoming a maintainer

By invitation of the existing maintainers, after sustained good contributions. There is no application.

## Stale pull requests

A pull request with no activity gets a polite nudge after two weeks. After four weeks it is closed, with an invitation to reopen it when you have time. Closing is housekeeping, not a verdict.

## Security and conduct

Security problems go through [SECURITY.md](SECURITY.md), privately. Behaviour is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Changing this file

Like everything else: a pull request that Mak Allen approves.
