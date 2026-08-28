# Use two agent types

**Superseded (station#975, 2026-07-27):** the agent-editor half of this ADR's model —
a fixed `AgentType` (`managed`/`connected`/`acp`) driving a fixed editor tab set — is
superseded by `docs/design/agent-engine-unification.md` §1/§4: an agent's editor
surfaces and validation now derive from its bound engine's `EngineCapabilityMatrix`,
not from a three-way type. **`AgentType` retired in slice 6 (station#1003,
2026-07-27):** `AgentType`/`resolveAgentTypeFromRuntimeConnection` are deleted from
`agent-capability-profile.ts`; the validator (`requiresAgentPromptForRuntime`) and
registry (`isExternalEngineBoundAgent`) consumers now branch on
`resolveEngineCapabilityMatrix(...).engineId`/`.systemPrompt.state` instead. Kept for
history.

Station has two agent types: Station agents and External agents. ACP is a connection method for an External agent, not a third type, because the product question is what runs the agent loop: Station's engine or an external Agent app.
