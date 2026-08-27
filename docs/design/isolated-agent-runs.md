# Isolated Agent Runs

Status: design note

## Purpose

Normal chat sessions should keep using the current project checkout and runtime connection. Long-running autonomous work is different: Ralph, team execution, scheduled code work, and future project-task runs may need isolation so agent edits, temp homes, ports, and cleanup do not disturb the user's primary workspace.

This note captures a survey-inspired isolation pattern (internal competitive notes) without making git worktrees mandatory.

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
