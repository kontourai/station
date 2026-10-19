---
"@kontourai/station-contracts": minor
---

Export `TURN_COMPLETION_NOTIFICATION_SOURCE`, the `source` (and envelope `source.subsystem`) of the notification records Station writes when an agent's turn finishes, stops or fails, so clients can tell those records from other writers'.

Export `OPENED_NOTIFICATION_QUERY_PARAM`, the query parameter a Web Push or desktop alert's open link carries to name the record it opens, so the client that loads the link can mark that record read.
