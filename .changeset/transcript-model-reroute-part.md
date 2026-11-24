---
"@kontourai/station-shared": minor
---

A `model.rerouted` transcript marker part now carries `modelReroute` (`sessionId`, `turnId` when the engine named the turn, and `scope`), so a reader can tell which turn ran on another model than it asked for without parsing the marker text. A subagent's reroute carries none. The marker text is unchanged.
