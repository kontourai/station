---
"@kontourai/station-contracts": patch
---

Mark `AgentSpec.streaming` (`useNewPipeline`, `enableThinking`,
`debugStreaming`) deprecated in the contract and in `schemas/agent.schema.json`.
Station reads none of these fields; agent files that carry them still load.
The server no longer reads `DEBUG_STREAMING`. Document that
`partialMessageIncluded` is only true on summaries earlier builds persisted.
