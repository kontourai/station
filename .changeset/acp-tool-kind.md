---
'@kontourai/station-contracts': minor
'@kontourai/station-shared': minor
---

`tool.started` and `tool.completed` carry an optional `toolKind`
(`EngineToolKind`, the Agent Client Protocol `ToolKind` vocabulary) when the
engine reported one, and the shared transcript projection copies it onto the
tool part as `MessagePart.toolKind`. A tool part bound to a pending approval
also carries `approvalToolName`, the tool name the request itself reported.
`toolRequestGrantLabel` now reads "Allow for this session" when the request
reported no tool name, instead of claiming a grant for "this tool".
