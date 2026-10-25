# Station agent instructions

## Start here

- GitHub owns live work state. Check `git status -sb` against `origin/main`.
- Work only in a sibling worktree (`../station-worktrees/<lane>`), never the primary checkout or a nested worktree. Preserve intentional changes; never use `git stash`; after review begins, integrate upstream with `git merge origin/main`, not rebase.
- Use an isolated Station home, instance name, and non-default ports. Ports 3141 and 3000 belong to the user.
- Hand a running instance to the operator through a freshly minted `station open --print` sign-in link (single-use), never a bare `localhost` URL. Mint it at handoff, not at start; see [development](docs/guides/development.md).
- Run `npm run dependencies:ci` to arm hooks; managed installs use pinned pnpm and `npm run` is the script interface, so never run raw npm installs. Before editing, run `npm run gate:for -- <paths...>`, then `npm run test:focused -- <file...>`, not ad-hoc `npx vitest`.
- Never `git push --no-verify`: no required CI check re-runs the pre-push gates. The transfer gate uses `STATION_TRANSFER_BASELINE_ROOT`; slow captures use `STATION_TRANSFER_CAPTURE_TIMEOUT_MS` ([testing](docs/guides/testing.md#pre-push-orchestration-transfer-gate)).
- Ordinary PRs use focused evidence and normal hooks; hosted checks and the merge queue own broad integration and full typechecking. A selector explanation, deferred selection (`test:changed` exit 3), or rerun is not completion evidence. Run local `ci:fast` only for a specific failure or explicit request, never `full:regression` merely because `main` moved. Never background a full `typecheck` or `ci:fast` to poll its sentinel. [Verification](docs/guides/development.md#verification) owns lane selection and exact-SHA receipts; focused evidence, hosted qualification, and Nightly usability remain distinct.
- Diagnose the failure rather than rerun-to-green: a red lane is a signal to diagnose, not a request to rerun until green. For a redundant same-digest run, join or reuse the existing lease.
- If an explicit submission handoff is active, freeze the worktree. Never use shell background or relaunch loops, and do not edit or remove a worktree with a live handoff.

## Landing a pull request

Arm auto-merge (`gh pr merge <n> --repo kontourai/station --auto`) with no merge-method flag, confirm once, then stop; never merge by hand or arm another lane's in-flight PR. [Landing a pull request](docs/guides/development.md#landing-a-pull-request) has the confirmation query; the ruleset owns required checks, strategy, and batching (currently 1 build, up to 3 merges, `ALLGREEN`). The guide covers attribution, queue confirmation, and base freshness.

## Test evidence

Tests must reach the behavior their names claim and fail when it breaks. Helper tests do not prove caller integration; missing prerequisites and caught errors must not become success. For fault injection, commit and confirm a clean tree first, preserve intervening edits, and report baseline, injected failure, and restored outcomes. Fixture, cleanup, and performance work follows [the test-effectiveness route](docs/guides/testing.md#fixture-fidelity-and-test-effectiveness).

## Issue references

`archive#NNNN` is [kontourai/station-archive](https://github.com/kontourai/station-archive), the pre-2026-08-28 history. Here, #27–#601 re-file archive issues under new numbers (see the [map](docs/migration/issue-number-map.json)), so low numbers exist in both repos.

A bare `#NNNN` means this repo, except pre-reset text in areas the sweep skipped (notably `packages/cli`, `packages/sdk`, `packages/connect`, `scripts`, `docs/adr`). When unsure, check both repos. Write `#NNNN` for this repo, `archive#NNNN` for the archive.

## Read only the route you need

For behavior or public-contract changes, use [documentation-audit](.agents/skills/documentation-audit/SKILL.md). Ship a new user-facing capability behind a [Feature Preview](docs/guides/feature-previews.md).

Codex loads only this root automatically; read the routed scope explicitly. Claude's nested `CLAUDE.md` imports its paired `AGENTS.md`.

| Touched path | Read |
| --- | --- |
| Documentation, decisions | [docs/guides/documentation.md](docs/guides/documentation.md) |
| `src-server/**` | [src-server/AGENTS.md](src-server/AGENTS.md) |
| `src-ui/**`, `packages/basis-pane/**`, `packages/board-pane/**` | [src-ui/AGENTS.md](src-ui/AGENTS.md) |
| `scripts/**`, `.github/**`, root configuration, package scripts | [scripts/AGENTS.md](scripts/AGENTS.md) |
| `src-desktop/**` | [src-desktop/AGENTS.md](src-desktop/AGENTS.md) |
| `packages/contracts/**` | [packages/contracts/AGENTS.md](packages/contracts/AGENTS.md) |
| `packages/sdk/**` | [packages/sdk/AGENTS.md](packages/sdk/AGENTS.md) |
| `tests/**` | [tests/AGENTS.md](tests/AGENTS.md) |

Read [docs/glossary.md](docs/glossary.md), the affected canonical guide, and [docs/architecture/module-map.md](docs/architecture/module-map.md) only when their topic is in scope. Station consumes sibling Kontour products through published contracts, never their internals.

<!-- veritas:governance-block:start -->
This repo uses Veritas for AI governance. Read `.veritas/GOVERNANCE.md` before making changes.
After changes, run `npx --no @kontourai/veritas readiness` and address any FAIL lines before finishing.
If npx says the package is missing, install this repo's dependencies, adding `@kontourai/veritas` as a development dependency if it is not one, and run it again.
<!-- veritas:governance-block:end -->
