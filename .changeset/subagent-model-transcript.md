---
'@kontourai/station-contracts': minor
'@kontourai/station-sdk': minor
---

A `ChildWorkItem` can carry the subagent's own `model` (`{ id, source }`),
reported by its engine: a Claude subagent's own reply, a Codex `spawnAgent`
result, or a Codex child thread. When the engine reports none, the field is
absent and the Agents pane shows "model not reported", never the parent's
model. Codex's spawn model moved from `kindLabel` to `model`. A Claude
subagent also carries a `transcript` reference, and the new
`GET /api/orchestration/sessions/:threadId/child-work/:childId/transcript`
route and `useChildWorkTranscriptQuery` hook serve its transcript read-only,
paged by message (`ChildWorkTranscriptPage`).
