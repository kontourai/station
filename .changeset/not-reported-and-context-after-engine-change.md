---
"@kontourai/station-shared": minor
---

A usage figure nobody reported reads "Not reported" instead of a dash (#5390): `UNREPORTED_MEASUREMENT_TEXT` is now `'Not reported'`, so `formatMeasuredTokens` and `formatMeasuredCostUsd` return it for `undefined`; a reported zero still formats as zero. `enginesReportingTokensSeparately` (in `usage-measurement`) returns the engines a conversation's token figures are listed by when more than one engine reported tokens, and `undefined` when the conversation has a single token total.

`foldLineageUsageEvents` no longer carries the previous engine's context figure past an engine change: context occupancy comes from the newest run that has one since the last engine change, so the figure is absent until the new engine reports. The latest figures now come from the run that holds the newest Session, which matters only when a Session continues a run that is not the last one. The per-Session fold in `usage-fold` is unchanged.
