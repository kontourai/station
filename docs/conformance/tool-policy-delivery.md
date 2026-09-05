# Pre-tool blocking and grant delivery boundary

`EngineCapabilityMatrix.toolPolicy` declares only whether Station can make a
pre-tool blocking or grant decision on the actual tool-call path. It does not
claim that post-hoc configuration, quality, or uniform-stop gates are absent.

The managed Station engine delivers its full pre-tool chain through
`beforeToolCall`. Claude Code is partial, and the boundary is narrower than it
once was: alongside `canUseTool` (which honours a resolved agent's matching
`tools.autoApprove` patterns) a `PreToolUse` hook runs Station's staged
evaluator, so stale-generation, delegated-tool, config-protection and
approval-guardian decisions DO reach the actual tool-call path. What it still
does not deliver is the unattended-grant chain: the staged evaluator hands
external interaction back to the engine's own permission flow before those
stages, and the external adapters carry no unattended principal for them to
read.

Handing interaction back is also all Station does about consent on that path:
in Ask mode the engine asks before tool calls its own rules and classifier do
not already allow, and the user's and the workspace's Claude settings files
apply (no `settingSources` is set), so a rule in one of those allows a call
without a Station approval request. Station adds no floor over it.

ACP is equivalently partial at its protocol `requestPermission`
callback, through the same staged evaluator and with the same one gap. Codex
has no Station pre-tool interception seam. Muse is also unsupported. An
unknown external engine fails closed with no pre-tool delivery.

The matrix is authoritative for UI and conformance consumers. Its declared
adapter modules are also the source for the tripwire, so a declared adapter
module cannot silently gain a managed pre-tool seam while its matrix remains
stale. This does not claim that every possible `EngineId` string is a
registered adapter; unknown engines remain fail-closed through the separate
unknown-engine matrix.
