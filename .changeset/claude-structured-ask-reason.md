---
'@kontourai/station-shared': minor
---

Read Claude Code's structured ask reason when deciding what a tool-level
allowance may answer (#2932). `tool-request-preview` adds `claudeAskEscalates`
and the `ClaudeAskReason` type, `ToolRequestGrantInput` gains an optional
`claudeAsk`, and `toolRequestSessionGrantFromPayload` reads it from a
`request.opened` payload. A Claude ask escalates, so neither a tool grant nor
`toolRequestIsPlainCall` covers it, when its reason type is anything but
`other`, when `classifierApprovable` is set, when type `other` carries any
reason but `This command requires approval`, or when `claudeAsk` is present
but is not an object (`null`: the engine's request was not read). An ask with
no reason type, and a request with no `claudeAsk` at all (another engine), is
judged as before. Station's Claude sessions therefore prompt for Bash safety
checks, plain `permissions.ask` rules, sensitive-file edits and every
compound shell command, under a session grant and under an agent's
`tools.autoApprove`.
