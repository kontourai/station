# Self-Configuring Agent Example

An attended Station-engine Agent that uses `station-control` to inspect Project
metadata, refine an existing writable skill, and delegate a focused task.

It is an Agent configuration, not a plugin. It shows how to:

- inspect Station's Project and Agent records
- refine reusable skills
- delegate narrow work to child agents
- use Station's default child policy where the worker's engine delivers it

Configure a usable Model connection and default model before running it. Copy
`agent.json` into the `agents/workspace-bootstrapper/` directory of the Station
home you intend to use, or create the same Agent through Station's Agent editor.
The file has no external-engine binding; it uses Station's engine.

Only four metadata reads are auto-approved. Skill edits, delegation, task control,
and other exposed calls remain subject to approval and the caller's authority.
No unattended grants are included.

Delegation also obeys [dispatch authority](../../docs/guides/self-configuring-agent.md#dispatch-authority).
Non-operator callers stay with their own owner's local work and required Project
actions; callers without bound assurance also stay within their Session's scope.
Saved-Environment discovery and remote work require a bound operator caller.
Approving a tool call does not supply that authority.

## Files

- [agent.json](./agent.json) — example orchestrator agent config

## What this agent is for

The `Workspace Bootstrapper` is meant to be asked things like:

- "Read this Project's metadata and suggest a review workflow"
- "Propose an edit to the existing onboarding skill"
- "Find a ready worker and delegate this focused task"

This allowlist does not inspect repository files, create skills, or modify
Project configuration. Prepare a writable skill first. A worker needs its own
tools and access to perform repository work; metadata visibility does not grant
that access. `track_skill_run` records an explicit usage report; outcome recording
is not exposed by this example.

Do not add a `delegation` JSON field: the current Agent schema rejects it.
Station derives the default child context. Check the selected engine's policy
delivery before relying on its tool restrictions; lineage is not a filesystem
sandbox. No live model, authentication, or delegated execution is established
by this example's schema/loader checks.

Use this together with [Build a Self-Configuring Agent](../../docs/guides/self-configuring-agent.md).
