---
'@kontourai/station-shared': minor
---

Read Claude Code's structured ask reason when deciding what a tool-level
allowance may answer (#2932). `tool-request-preview` adds `claudeAskEscalates`
and the `ClaudeAskReason` type, `ToolRequestGrantInput` gains an optional
`claudeAsk`, and `toolRequestSessionGrantFromPayload` reads it from a
`request.opened` payload. A Claude ask escalates, so neither a tool grant nor
`toolRequestIsPlainCall` covers it, when `classifierApprovable` or a
`decisionReasonCode` is set; when its reason type is anything but `other` or
`subcommandResults`; when type `other` carries any reason but `This command
requires approval`; when a `subcommandResults` ask is not on Bash (every
PowerShell ask) or carries a `matchedAskRule` or any `decisionReason` text;
when a Bash or PowerShell ask carries no reason type; or when `claudeAsk` is
present but is not an object (`null`: the engine's request was not read).
Any other ask with no reason type, and a request with no `claudeAsk` at all
(another engine), is judged as before. Station's Claude sessions therefore
prompt for safety checks, ask rules on a single command, sensitive-file
edits and every PowerShell ask, under a session grant and under an agent's
`tools.autoApprove`. A chained Bash command with no safety check is still
answered by a grant. When more than one part needs approval, an ask rule on
the chain or on one of its parts, a write or delete outside the working
directories in an `&&` or `;` chain or behind a pipeline's redirect, and a
part's warning that is not a safety check are not visible on the engine's
request, as before this change.
