# Station agent instructions

## Start here

- GitHub owns live work state. Check `git status -sb` against `origin/main`.
- Work only in a sibling worktree (`../station-worktrees/<lane>`), never the primary checkout or a nested worktree. Never use `git stash`; after review begins, integrate upstream with `git merge origin/main`, not rebase.
- Use an isolated Station home, instance name, and non-default ports. Ports 3141 and 3000 belong to the user.
- Run `npm run dependencies:ci` to arm hooks; `npm run` is the script interface, so never run raw npm installs. Before editing, run `npm run gate:for -- <paths...>`, then `npm run test:focused -- <file...>`, not ad-hoc `npx vitest`.
- Never `git push --no-verify`: no required CI check re-runs the pre-push gates.
- Ordinary PRs use focused evidence and normal hooks; hosted checks and the merge queue own broad integration and full typechecking. Never background a full `typecheck` or `ci:fast` to poll its sentinel. [Verification](docs/guides/development.md#verification) owns lane selection and receipts.
- Diagnose the failure rather than rerun-to-green: a red lane is a signal to diagnose, not a request to rerun until green. For a redundant same-digest run, join or reuse the existing lease.
- If an explicit submission handoff is active, freeze the worktree. Never use shell background or relaunch loops, and do not edit or remove a worktree with a live handoff.

## Landing a pull request

Arm auto-merge (`gh pr merge <n> --repo kontourai/station --auto`) with no merge-method flag, confirm once, then stop; never merge by hand or arm another lane's in-flight PR. [Landing a pull request](docs/guides/development.md#landing-a-pull-request) has the confirmation query; the ruleset owns required checks and batching.

## Test evidence

Tests must reach the behavior their names claim and fail when it breaks. Helper tests do not prove caller integration; missing prerequisites and caught errors must not become success. For fault injection, commit and confirm a clean tree first, preserve intervening edits, and report baseline, injected failure, and restored outcomes. Fixture, cleanup, and performance work follows [the test-effectiveness route](docs/guides/testing.md#fixture-fidelity-and-test-effectiveness).

## Issue references

`archive#NNNN` is [kontourai/station-archive](https://github.com/kontourai/station-archive), history before 2026-08-28; #27–#601 here re-file archive issues, so low numbers exist in both. A bare `#NNNN` means this repo, except older text in `packages/cli`, `packages/sdk`, `packages/connect`, and `scripts`; check both when unsure.

## Read only the route you need

For behavior or public-contract changes, use [documentation-audit](.agents/skills/documentation-audit/SKILL.md).

Codex loads only this root automatically; read the routed scope explicitly. Claude's nested `CLAUDE.md` imports its paired `AGENTS.md`.

| Touched path | Read |
| --- | --- |
| Documentation, decisions | [docs/guides/documentation.md](docs/guides/documentation.md) |
| `src-server/**` | [src-server/AGENTS.md](src-server/AGENTS.md) |
| `src-ui/**` | [src-ui/AGENTS.md](src-ui/AGENTS.md) |
| `scripts/**`, `.github/**`, root configuration, package scripts | [scripts/AGENTS.md](scripts/AGENTS.md) |
| `src-desktop/**` | [src-desktop/AGENTS.md](src-desktop/AGENTS.md) |
| `packages/contracts/**` | [packages/contracts/AGENTS.md](packages/contracts/AGENTS.md) |
| `packages/sdk/**` | [packages/sdk/AGENTS.md](packages/sdk/AGENTS.md) |
| `tests/**` | [tests/AGENTS.md](tests/AGENTS.md) |

Read [docs/glossary.md](docs/glossary.md), the affected canonical guide, and [docs/architecture/module-map.md](docs/architecture/module-map.md) only when their topic is in scope. Station consumes sibling Kontour products through published contracts, never their internals.

<!-- veritas:governance-block:start -->
This repo uses Veritas for AI governance. Read `.veritas/GOVERNANCE.md` before making changes.
After changes, run `npx --no @kontourai/veritas readiness` and address any FAIL lines before finishing.
<!-- veritas:governance-block:end -->
