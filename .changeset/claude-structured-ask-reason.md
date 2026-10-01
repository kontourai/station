---
'@kontourai/station-shared': minor
---

Read Claude Code's structured ask reason when deciding what a tool-level
allowance may answer (#2932). `tool-request-preview` adds `claudeAskEscalates`
and the `ClaudeAskReason` type, `ToolRequestGrantInput` gains an optional
`claudeAsk`, and `toolRequestSessionGrantFromPayload` reads it from a
`request.opened` payload. A Claude ask escalates, so neither a tool grant nor
`toolRequestIsPlainCall` covers it, when its reason type is anything but
`other` or `subcommandResults`, when `classifierApprovable` is set, when a
`subcommandResults` ask (a compound shell command) carries a `matchedAskRule`
or any `decisionReason` text or is not on a shell tool, when type `other` carries any
reason but `This command requires approval`, when a Bash or PowerShell ask
carries no reason type, or when `claudeAsk` is present but is not an object
(`null`: the engine's request was not read). Any other ask with no reason
type, and a request with no `claudeAsk` at all (another engine), is judged
as before. Station's Claude sessions therefore prompt for Bash safety
checks, plain `permissions.ask` rules and sensitive-file edits, under a
session grant and under an agent's `tools.autoApprove`. A compound shell
command with no such signal is still answered by a grant; an exact ask rule
on one of its parts is not visible there.
