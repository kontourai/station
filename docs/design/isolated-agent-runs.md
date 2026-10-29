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

This records the selected starting source. It does not freeze the checkout,
prevent agent edits, certify subsequent output, prepare tools or grant setup
authority. Shared-workspace Sessions do not resolve a new base. The broader run
record and command below remain proposals. Source-pinning and foreground
metadata are covered by the
[real Git provisioning tests](../../src-server/services/projects/__tests__/worktree-provisioning-service.test.ts)
and [foreground caller test](../../src-server/services/execution-target/__tests__/execution-target-execution.test.ts);
these fixtures do not establish a live engine or packaged-release journey.

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
