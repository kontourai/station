---
'@kontourai/station-shared': minor
---

Say which requests a tool-level allowance may answer (#2933).
`tool-request-preview` adds `toolRequestIsPlainCall`, true only for the `tool`
and `edit-mode` session grants, and `toolRequestIsPlanExit`, which also treats
an ACP `switch_mode` tool kind as a plan exit. `ToolRequestGrantInput` gains an
optional `toolKind`, read from a payload's `toolKind`, and such a request offers
no session grant. Station uses them so an agent's `tools.autoApprove` pattern
never answers an escalation or a plan exit. On Claude Code and ACP a broad
pattern therefore no longer covers escalations: a headless run that reaches one
waits on an approval request, and a delegated child that cannot grant approvals
is denied the call at once.
