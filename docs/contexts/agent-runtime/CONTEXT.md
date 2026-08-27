# Agent Runtime Context

Agent Runtime covers how Station starts, drives, observes, resumes, and stops agent work across Station agents and External agents.

## Language

**Agent loop**:
The ongoing read-think-act cycle that produces work. Station owns the loop for Station agents; an Agent app owns the loop for External agents.
_Avoid_: runtime when user-facing

**Station agent**:
An agent whose loop is run by Station's engine. Station owns prompt, model choice, skills, integrations, tools, commands, guardrails, and delegation.
_Avoid_: managed agent

**External agent**:
An agent whose loop is run by an Agent app such as Claude Code, Codex, or Kiro. Station drives and observes it but does not own its behavior or tools.
_Avoid_: connected agent, ACP agent

**Agent app**:
An external program that runs an agent loop. ACP is one connection method to an Agent app, not a separate agent type.
_Avoid_: runtime connection in user-facing language

**Virtual agent**:
An agent entry synthesized from an Agent app connection, direct-chat path, or ACP mode. It is selectable like an agent but remains backed by the app.
_Avoid_: installed Station agent

**Agent session**:
A bounded episode of agent work with lifecycle state, events, turns, project context, selected agent, and possible Flow run binding.
_Avoid_: chat when lifecycle or evidence matters

**Turn**:
One interaction within an agent session. A turn can include text, reasoning, tool calls, approval requests, terminal events, and completion events.
_Avoid_: message when the event stream matters

**Canonical runtime event**:
Station's normalized event language for all agent execution paths. It is the event seam that makes any-runtime-one-gate possible.
_Avoid_: provider event after it crosses into Station

**Session lifecycle**:
Station's state machine for sessions: queued, running, needs input, review pending, blocked, completed, failed, or canceled.
_Avoid_: provider status

**Agent run**:
The execution accounting record for an orchestration-backed agent session, including provider, execution class, retry state, attempt, and failure kind.
_Avoid_: Flow run

**Delegation**:
A controlled handoff from one agent to another, with depth, parent session, tool restrictions, and approval restrictions.
_Avoid_: subtask when agent authority matters

**Guardrail**:
A Station-agent execution limit or setting such as max tokens, temperature, stop sequences, or max steps.
_Avoid_: policy class

**Workspace isolation**:
The mode that decides whether an agent session works in the shared project workspace or in an isolated Git worktree.
_Avoid_: sandbox when the isolation unit is the workspace

**Workflow sidecar**:
A file-backed Flow Agents process-state record that survives handoff, compaction, and Agent app switches.
_Avoid_: conversation memory

## Relationships

- A Station agent uses Station's engine and a Model.
- An External agent is backed by an Agent app and may be reached through native SDKs or ACP.
- A virtual agent is a selection surface for an Agent app mode or direct connection path.
- An agent session emits canonical runtime events and may produce an agent run.
- A workflow sidecar can bind multiple sessions to the same task across Agent app switches.
- Workspace isolation shapes where the agent writes, not what the agent is allowed to claim.

## Flagged Ambiguities

**Runtime**:
Use Station's engine, Agent app, Station core, or External agent depending on the intended meaning.

**Session versus run**:
Session is the work episode and event stream. Run is execution accounting. Flow run is evidence-gated process state.
