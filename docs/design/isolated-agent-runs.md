# Isolated Agent Runs

Status: Proposal — unscheduled; no tracking issue as of 2026-10-20.

> **Reading status: design proposal.** The run record and `station run isolate`
> command below describe a proposed interface, not an installation instruction
> or a claim about current command availability. Use the [CLI reference](../reference/cli.md)
> for supported commands. Current Project workspace selection and worktree
> provisioning belong to the
> [execution-target resolver](../../src-server/services/execution-target/execution-target-resolver.ts)
> and [foreground executor](../../src-server/services/execution-target/execution-target-execution.ts).
> Their existence does not establish this proposal's complete isolated-run lifecycle.


## Current Project worktree source identity

[Worktree provisioning](../../src-server/services/projects/worktree-provisioning-service.ts)
resolves the configured `baseRef` (default `HEAD`) to a full Git commit before
creating an owned Project worktree. Checkout uses that exact commit even if the
ref moves afterwards. Resolution and checkout disable Git replacement objects,
so a replace ref cannot silently substitute another commit's contents.
Missing refs and non-commit objects refuse before the worktree directory or
branch is created. Existing dirty-repository, configuration,
path and ownership checks still apply.

[Session metadata](../../packages/contracts/src/workspace-isolation.ts) retains
both the configured `baseRef` and its resolved `baseCommit`. The
[foreground executor](../../src-server/services/execution-target/execution-target-execution.ts)
passes those facts with the owned worktree at Session start. `baseCommit` is
optional for older records: absence means the starting commit was not recorded,
not that the current value of `baseRef` reconstructs it.
A Task dispatch on a worktree-isolated Project passes the Task's owned worktree
the same way ([Task dispatch](task-dispatcher.md#workspace-isolation)); a Task
worktree adopted from a checkout the Task had not recorded yet has no
`baseCommit`, for the same reason.

This records the selected starting source. It does not freeze the checkout,
prevent agent edits, certify subsequent output, prepare tools or grant setup
authority. Shared-workspace Sessions do not resolve a new base. The broader run
record and command below remain proposals. Source-pinning and foreground
metadata are covered by the
[real Git provisioning tests](../../src-server/services/projects/__tests__/worktree-provisioning-service.test.ts)
and [foreground caller test](../../src-server/services/execution-target/__tests__/execution-target-execution.test.ts);
these fixtures do not establish a live engine or packaged-release journey.

## Worktree output settlement

A Session that started in a worktree of its own has at most one recorded
outcome for its output ([#4771](https://github.com/kontourai/station/issues/4771)).
The [settlement service](../../src-server/services/projects/worktree-output-settlement-service.ts)
records it in the orchestration database; the
[contract](../../packages/contracts/src/workspace-isolation.ts) names the
shapes, and the [API reference](../reference/api.md#worktree-output-settlement)
the route. A settlement is a receipt about a decision. It is not a review
verdict or a gate result, and Station never writes to the base checkout to
make one true. It is not a third proposal lifecycle either:
[ProposedChange](../../packages/contracts/src/proposed-change.ts) and corpus-store
proposals settle a proposed content change by approval, while this records an
effect already taken (a discard, a cleanup) or a state already verified in Git
or at the forge.

| Outcome | Recorded when | Git effect |
| --- | --- | --- |
| `discarded` | A person asks. | Station removes the worktree and branch it created for that Session, and nothing else. It is refused while the branch has moved on or is checked out elsewhere; only completing an earlier discard whose worktree is already gone keeps the branch then. |
| `kept` | The base ref's current tip contains the branch head commit. | None. Station does not merge. |
| `released` | The forge reports an `OPEN` or `MERGED` pull request whose head branch and head commit equal the worktree branch's. | None. |
| `cleaned-up-without-decision` | The Session-exit cleanup policy removed the worktree and no settlement existed. | The cleanup policy's own removal. |

`kept` is derived, never asserted: a request to record it is refused with
`base-does-not-contain-head` unless `git merge-base --is-ancestor` finds the
branch head in the base ref's tip, resolved at request time with replacement
objects disabled. The base must name a local or remote-tracking branch, recorded
as `baseBranch`; a branch name is read as `refs/heads/<name>`, so a tag of the
same name cannot stand in for it, and a tag or a commit id is refused
(`base-unresolvable`). The default `baseRef` is `HEAD`: any spelling of it
(`HEAD`, `@`, or `head` where the filesystem folds case) is resolved to the
branch the repository's checkout has checked out now. A detached checkout
names no branch (`base-detached`), and a
checkout of the Session's own branch would contain its head trivially
(`base-is-session-branch`); both are refused. A fast-forward merge, whose
containing commit is the head itself, is kept. A squash or rebase merge creates new commits, so the base
never contains the original head; such a merge is recorded as `released`
through its merged pull request instead. Deriving `kept` from a merged pull
request would also need the pull request's target to be the worktree's base,
and `baseRef` is often `HEAD`, which names no branch. `kept` is also refused
while the worktree has uncommitted or untracked changes, and for a branch with
no commit beyond the one it started from.

`released` uses the existing [pull request identity read](../../src-server/services/pull-requests/pull-request-identity-read.ts)
that conversation links and Task close-out use, with the forge credentials
Station already has. The caller names the pull request; the forge's state,
head branch and head commit decide. A commit SHA match is the evidence; the
pull request's repository is not separately matched to the worktree's remote.
The read waits at most 30 seconds and is then refused as
`pull-request-unavailable`: requests for one Session, Session-exit cleanup
included, run one at a time, so a slow forge would hold them.

Each record carries the actor (the request's authenticated principal, or
Station's cleanup policy), the request key, the repository, worktree path,
branch, `baseRef`, the starting `baseCommit` when known, the head commit the
decision was made on, the time, and the evidence: the containing commit, the
pull request read, or what the discard removed and whether it accepted losing
uncommitted changes. A recorded outcome does not change when the base moves
later; it states what was true when it was made.

**Once only.** A second settlement is refused (`already-settled`) and the first
record is unchanged. The same request key with the same request returns the
original record; the same key with a different request is refused
(`request-key-mismatch`). The table's triggers refuse any update or delete of
a settled row.

**Discard and crashes.** No outcome is recorded while a turn runs in the
Session's worktree (`session-running`), the rule Task finalization follows.
A discard is refused while the worktree has uncommitted or untracked changes
unless the request sets `acceptUncommittedLoss`, which the record keeps.
Files the repository ignores are removed without that acceptance (requiring
it would make every worktree with build output need it); the record counts
the ignored paths `git status` listed as `ignoredEntries` (every file in an
ignored directory counts). A discard is also refused, before anything is
removed, while another checkout has the Session's branch checked out
(`branch-checked-out-elsewhere`), or while the branch has moved past the head
just inspected (`branch-moved`). Station never hands git a worktree path that
is a symlink or not a directory (`worktree-path-not-a-directory`), that now
holds another repository (`worktree-replaced`), or whose repository has gone
(`repository-missing`): `git worktree remove` would delete through a symlink.

Station writes the discard's intent (`pending`) before any Git effect, naming
the process that wrote it (pid and birth fingerprint). It then removes the
worktree (forced only with that acceptance) and deletes the branch only at the
recorded head. If the process stops between the effect and the record, a retry
with the same request key completes it as recorded, reporting what this
attempt still had to remove; once the worktree is gone, a branch that moved or
was checked out since is kept, and the record says why (`branchKept`). Another
request waits (`settlement-pending`) while the process that wrote the intent
may still be running it. Once that process is provably gone, an intent whose
worktree is still intact had no effect and gives way, and a discard request
completes one whose removal had started (the record keeps its original
requester).

**Cleanup policy.** Session-exit cleanup records
`cleaned-up-without-decision` only when it removed the worktree and no
settlement existed; a decision made first stands. Its `afterCleanup` evidence
is what Station observed afterwards (`present`, `absent`, or `unknown` when
git could not tell), not who removed it: cleanup's branch deletion may fail
for a branch checked out elsewhere, and a folder deleted before the Session
exited is observed absent too. Unlike a discard, it writes no intent first: a
crash between that removal and its record leaves no record. A cleanup policy
that would remove the worktree does not run on a path that is a symlink or
holds another repository; a preserve policy leaves it untouched.

**Scope and limits.** Task-owned worktrees ([#4507](task-dispatcher.md#workspace-isolation))
are shared by a Task's Sessions and are refused here (`task-owned-worktree`).
Station does not apply output onto a base that has moved, and records
`kept` and `released` without removing the worktree. Operations on one
Session run one at a time within a Station service; across processes, one
row per Session makes the recorded outcome at most one, and a pending intent
is taken over only from a process that is provably gone, or by its own
request key. Two processes retrying the same request key at once can both
run the discard's Git steps; the branch deletion only at the recorded head
and the single pending row keep the result to one discard, and one of them
may answer with an error rather than the record. Two processes can still both read and verify before either
records; the second then finds the first's row and is refused. The
[real Git tests](../../src-server/services/projects/__tests__/worktree-output-settlement.test.ts)
cover discard ownership, uncommitted and ignored changes, a branch checked out
elsewhere, kept (including `HEAD` bases), squash merges, released, replay, a
moved base (including one that edited the same file, refused until a merge
resolves it), crash convergence, the intent being recorded before the removal
runs, two services on one database, path shapes and the cleanup record; the forge in them is a scripted provider, not a live pull
request. A [runtime route test](../../src-server/runtime/routes/__tests__/runtime-routes-worktree-settlement.test.ts)
goes through the production route composition and scope table.

## Purpose

New chat Sessions use the selected Project directory and runtime connection. Qualified existing Sessions keep their recorded directory while its attached resource remains authorized. Long-running autonomous work is different: Ralph, team execution, scheduled code work, and future project-task runs may need isolation so agent edits, temp homes, ports, and cleanup do not disturb the user's primary workspace.

This note captures a survey-inspired isolation pattern without making git worktrees mandatory.

## Default Rule

Isolation is opt-in. A connected runtime chat session must not create a git worktree or mutate global workflow state just because the user sends a message.

## Run Shape

An isolated run should record:

- `runId`
- source workflow, such as `ralph`, `team`, `schedule`, or `project-task`
- original repository path
- workspace path
- optional git branch name
- Station instance name
- server and UI ports
- temp home path
- cleanup status
- output outcome; for a Session's own worktree this is recorded today as a
  [worktree output settlement](#worktree-output-settlement)

The orchestration run ledger is the read model for these records. It should expose state and failure metadata first. It should not become a second task queue.

## Command Shape

A future CLI command can follow this form:

```bash
./station run isolate --source=ralph --name=<run-id> --repo=<path> --dry-run
```

When execution is approved, it should derive a stable instance and port pair:

```bash
./station start --instance=<run-id> --temp-home --clean --force --port=<agent-port> --ui-port=<agent-ui-port>
```

Reserved ports `3141` and `3000` remain for user testing. Agent-owned runs must choose non-default ports.

## Git Worktree Rules

If git worktree creation is implemented:

- Branch names should be deterministic, for example `agent/<source>/<short-run-id>`.
- Branch collisions should receive a suffix rather than overwriting an existing branch.
- Worktree operations should run in temp/test directories in automated tests.
- Cleanup should remove only the created worktree and instance home.
- Generated agent context files should remain untracked unless the user explicitly commits them.

## Child-Agent Authority

Child agents may inspect run state and report findings. They must not cancel, clear, or mutate global workflow state unless their assigned lane explicitly says they own that lifecycle operation.

## Verification

Implementation should include temp-directory tests for naming, port selection, and cleanup targeting. A dry-run path should prove the selected workspace, branch, instance, and ports without mutating the user's main home or reserved ports.
