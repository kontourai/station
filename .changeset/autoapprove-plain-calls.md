---
'@kontourai/station-shared': minor
---

Say which requests a tool-level allowance may answer (#2933).
`tool-request-preview` adds `toolRequestIsPlainCall`, true only for the `tool`
and `edit-mode` session grants, and `toolRequestIsPlanExit`, which also treats
an ACP `switch_mode` tool kind as a plan exit, and `toolRequestNeedsPerson`,
true for a plan exit or a harness question (`AskUserQuestion`). `ToolRequestGrantInput` gains an
optional `toolKind`, read from a payload's `toolKind`, and such a request offers
no session grant. Station uses them so an agent's `tools.autoApprove` pattern
never answers an escalation or a plan exit. On Claude Code and ACP a broad
pattern therefore no longer covers escalations: a headless run that reaches one
waits on an approval request, and a delegated child that cannot grant approvals
is denied the call at once. An ACP plan exit answered "for this session" is
sent as the agent's allow-once option, so its `allow_always` option (such as
"yes, and auto-accept edits") is not reachable from a session answer.
