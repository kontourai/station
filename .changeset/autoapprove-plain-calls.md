---
'@kontourai/station-shared': minor
---

Say which requests a tool-level allowance may answer (#2933).
`tool-request-preview` adds `toolRequestIsPlainCall`, true only for the `tool`
and `edit-mode` session grants, and `toolRequestIsPlanExit`. Station uses them
so an agent's `tools.autoApprove` pattern never answers an escalation or a plan
exit.
