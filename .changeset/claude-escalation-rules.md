---
'@kontourai/station-shared': minor
---

Treat Claude Code's known escalation signals as asks that always prompt
(#2932). `ToolRequestGrantInput` gains optional `toolInput`, `decisionReason`,
`suppressAlwaysAllowRule`, `defaultToNo` and `requiresUserInteraction`, and
`toolRequestSessionGrantFromPayload` reads them from a `request.opened`
payload. A request escalates, so neither a tool grant nor
`toolRequestIsPlainCall` covers it, when its input sets
`dangerouslyDisableSandbox: true`, its `decisionReason` is exactly
`dangerouslyDisableSandbox`, `requiresUserInteraction` or the MCP organization
ceiling, or any of the three flags is true. A `SandboxNetworkAccess` request,
and one flagged `suppressAlwaysAllowRule`, offers no session grant. Bash safety
checks and plain ask rules still carry no signal and are not covered.
Agent SDK 0.3.278 forwards `suppressAlwaysAllowRule` and `defaultToNo`, so
those two apply now; `requiresUserInteraction` applies once an SDK forwards it.
