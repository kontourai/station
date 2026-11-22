---
"@kontourai/station-shared": minor
---

A usage figure nobody reported reads "Not reported" instead of a dash (#5390): `UNREPORTED_MEASUREMENT_TEXT` is now `'Not reported'`, so `formatMeasuredTokens` and `formatMeasuredCostUsd` return it for `undefined`; a reported zero still formats as zero. `enginesReportingTokensSeparately` (in `usage-measurement`) returns the engines a conversation's token figures are listed by when more than one engine reported tokens, and `undefined` when the conversation has a single token total.

`unreportedMeasurementClasses` and `describeUnreportedMeasurements` now name missing token counts for a `station-memory` view too ("The model did not report token counts for this chat."); its cost and context stay undisclosed, since Station prices and estimates those itself.

`foldLineageUsageEvents` no longer carries the previous engine's context figure or model past an engine change: both come from the newest run that has one since the last engine change, so they are absent until the new engine reports them. The latest figures now come from the run that holds the newest Session, which matters only when a Session continues a run that is not the last one. The per-Session fold in `usage-fold` is unchanged.
