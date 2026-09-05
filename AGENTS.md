# Station agent instructions

## Start here

- GitHub owns live work state. Check `git status -sb` and its relationship to `origin/main`.
- Work only in a sibling worktree (`../station-worktrees/<lane>`), never the primary checkout or a nested worktree. Preserve intentional changes: never use `git stash`; after review begins, integrate upstream with `git merge origin/main`, not rebase.
- Use an isolated Station home, instance name, and non-default ports. Ports 3141 and 3000 belong to the user.
- Run `npm run dependencies:ci` to arm hooks. Before editing, use `npm run gate:for -- <paths...>`; it routes to focused evidence. Run selected tests with `npm run test:focused -- <file...>`, not ad-hoc `npx vitest`.
- Managed installs use pinned pnpm; `npm run` is the script interface. Never run raw npm installs in this workspace.
- Never `git push --no-verify`; no required CI check re-runs the pre-push gates. The transfer gate reads `STATION_TRANSFER_BASELINE_ROOT`; slow hardware raises `STATION_TRANSFER_CAPTURE_TIMEOUT_MS` (see docs/guides/testing.md).
- `npm run test:changed -- --base=origin/main --explain` selects a diagnostic lane; exit 3 is provisional/deferred, not completion. For ordinary pull requests, run focused evidence and `npm run ci:fast`; GitHub's merge queue verifies the synthesized latest-main candidate. Do not run `npm run full:regression` locally merely because `main` moved.
- The reusable hosted full-regression workflow owns canonical completion receipts for Nightly and tagged preview/stable promotions. CI `workflow_dispatch` is the explicit diagnostic escape hatch. Builder `tests-evidence` uses that exact-SHA promotion receipt; focused test evidence remains diagnostic.
- Diagnose the failure rather than rerun-to-green: a red lane is a signal to diagnose, not a request to rerun until green. For a redundant same-digest run, join or reuse the existing lease.
- If an explicit submission handoff is active, freeze the worktree. Never use shell background or relaunch loops, and do not edit or remove a worktree with a live handoff.

## Landing a pull request

`main` is governed by the **main requires green checks** ruleset, and a merge
queue is part of it. What that means in practice:

- **Arm auto-merge; do not merge by hand.** `gh pr merge <n> --repo kontourai/station --auto`.
  Auto-merge is opt-in PER PR — a PR whose checks are green but which nobody
  armed simply sits forever. That, not a broken gate, is the usual reason a
  ready PR has not landed.
- **Pass no merge-method flag.** The queue owns the strategy, and
  `gh pr merge --squash` is refused with `The merge strategy for main is set
  by the merge queue`. Do not reach for `allowed_merge_methods` to settle
  this: the `pull_request` rule lists `["squash","merge"]`, which reads as
  permission to pass `--squash` and is the wrong conclusion. The binding
  value is `merge_method: "SQUASH"` on the **`merge_queue`** rule
  (`gh api repos/kontourai/station/rulesets/<id>`). The queue squashes; you
  just do not get to say so.
- **`gh pr merge` warns on success — read the queue, not the exit text.** A
  refused method flag prints a `!` line that looks like a failure while the
  PR is queued anyway, and a second attempt then reports `already queued to
  merge`. `autoMergeRequest` is also `null` for an entry that is already IN
  the queue, so the obvious check says "not armed" when it is. Confirm
  against the queue itself:

  ```bash
  gh api graphql -f query='{ repository(owner:"kontourai", name:"station") {
    mergeQueue { entries(first:20) { nodes {
      position state pullRequest { number } } } } } }'
  ```
- **The queue serializes.** `max_entries_to_merge: 1` and `ALLGREEN` grouping
  mean entries land one at a time and a red entry holds the ones behind it.
  Several PRs waiting is the queue working, not the queue stuck. Its
  check-response timeout is 120 minutes.
- **Required checks**: `fast-checks`, `CodeQL JavaScript and TypeScript`,
  `Dependency review`, `Windows PR portable floor`, `build-ios-verification`
  (the ruleset is the authority: `gh api repos/kontourai/station/rules/branches/main`).
  Branches are NOT required
  to be up to date (`strict: false`), so you do not have to rebase onto every
  intervening commit — but two independently green PRs can still break `main`
  in combination. `main-health.yml` files a P1 when that happens.
- **Attribution matters.** The ruleset sets
  `require_extra_approval_for_unattributed_changes`, so a commit whose author
  GitHub cannot attribute needs an extra approval. Keep authorship real and
  put delegate credit in a `Co-authored-by:` trailer.
- **Do not arm another lane's in-flight PR.** Coordinate with the owning
  session first (`ListAgents` / `SendMessage`); a merge is not yours to make
  because the checks happen to be green.

## A test must execute the seam it is named for

Before adding or accepting a test, answer both: does it reach the code its name claims, and would it fail if the fix were reverted? A test that satisfies its name without touching its subject is worse than no test — it retires the question, so the next reader sees coverage and stops looking. Recurring shapes to reject: a constant asserted against its own literal; a source-text or config-shape scan (a regex over a file, a substring of workflow YAML) standing in for behaviour; a pure reducer or helper exercised while the defect lives in the integration that calls it; an assertion sitting behind a catch-all that converts the tested condition into an ordinary return.

When a mutation is the only convincing evidence, commit first and confirm `git status --short` is empty before injecting — restoring a dirty tree discards uncommitted work. Report the red result, not only the green: an injection that does not fail means the test lacks power or the mutation never reached the case. A fix round is where defects are introduced most often, so review the delta of a fix, not only the original change.

## Issue references

`archive#NNNN` — and any `station#NNNN` or bare `#NNNN` below #550, the reseeded backlog's start — refers to [kontourai/station-archive](https://github.com/kontourai/station-archive), the pre-2026-08-28 backlog and history. Those discussions remain readable there; this repository's own issues start fresh. Write new references as plain `#NNNN` for this repo or `archive#NNNN` for the archive.

Bare `#NNNN` references in areas the sweep has not touched (notably `packages/cli`, `packages/sdk`, `packages/connect`, `scripts`) predate the reset and refer to the archive as well.

## Read only the route you need

Codex loads this root file when launched here; it does not automatically load nested instructions after touching files. Read the routed scope explicitly. Claude loads nested `CLAUDE.md` when it reads that directory; each nested file imports its paired `AGENTS.md`.

| Touched path | Read |
| --- | --- |
| Documentation | [docs/guides/documentation.md](docs/guides/documentation.md) |
| `src-server/**` | [src-server/AGENTS.md](src-server/AGENTS.md) |
| `src-ui/**` | [src-ui/AGENTS.md](src-ui/AGENTS.md) |
| `scripts/**`, `.github/**`, root configuration, package scripts | [scripts/AGENTS.md](scripts/AGENTS.md) |
| `src-desktop/**` | [src-desktop/AGENTS.md](src-desktop/AGENTS.md) |
| `packages/contracts/**` | [packages/contracts/AGENTS.md](packages/contracts/AGENTS.md) |
| `packages/sdk/**` | [packages/sdk/AGENTS.md](packages/sdk/AGENTS.md) |
| `tests/**` | [tests/AGENTS.md](tests/AGENTS.md) |

Read [docs/glossary.md](docs/glossary.md), the affected canonical guide, and [docs/architecture/module-map.md](docs/architecture/module-map.md) only when their topic is in scope. Station consumes sibling Kontour products through published contracts, never their internals. `docs/strategy/roadmap.md` is historical, not live authority.

<!-- veritas:governance-block:start -->
This repo uses Veritas for AI governance. Read `.veritas/GOVERNANCE.md` before making changes.
After changes, run `veritas readiness` and address any FAIL lines before finishing.
<!-- veritas:governance-block:end -->
