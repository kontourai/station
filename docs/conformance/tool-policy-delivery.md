# Pre-tool blocking and grant delivery boundary

`EngineCapabilityMatrix.toolPolicy` declares only whether Station can make a
pre-tool blocking or grant decision on the actual tool-call path. It does not
claim that post-hoc configuration, quality, or uniform-stop gates are absent.

The managed Station engine delivers its full pre-tool chain through
`beforeToolCall`. Claude Code is partial: its `canUseTool` callback honours a
resolved agent's matching `tools.autoApprove` patterns, but it does not run
Station's stale-generation, delegated-tool, config-protection,
approval-guardian, or unattended-grant chain. ACP is equivalently partial at
its protocol `requestPermission` callback. Codex has no Station pre-tool
interception seam. Muse is also unsupported. An unknown external engine fails
closed with no pre-tool delivery.

The matrix is authoritative for UI and conformance consumers. Its declared
adapter modules are also the source for the tripwire, so a declared adapter
module cannot silently gain a managed pre-tool seam while its matrix remains
stale. This does not claim that every possible `EngineId` string is a
registered adapter; unknown engines remain fail-closed through the separate
unknown-engine matrix.
