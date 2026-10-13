---
'@kontourai/station-sdk': patch
---

`interruptDelegatedTask` results carry an optional `interruptOutcome`, the
outcome the Station that ran the stop derived (`InterruptTurnResult['outcome']`).
`no-active-turn` means nothing was interrupted, for example because the
requested `turnId` was not the running turn.
