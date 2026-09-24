---
'@kontourai/station-contracts': minor
---

Add `parseQualifiedPluginAgentId` and the `QualifiedPluginAgentId` and
`PluginAgentReference` types to `agent-identity` (#2400). The parser splits a
`'<plugin>:<agent>'` reference at its last colon into the plugin name and a
clean `AgentId`, and returns `undefined` when either half is not one.
