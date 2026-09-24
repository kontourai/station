---
'@kontourai/station-contracts': minor
---

Add the `delegationAttemptClaims` station capability flag for the opt-in portable delegation attempt-claim receiver slice: a build advertising it durably claims an accepted portable create under its verified delegation grant plus `attemptId` before any execution preparation, and answers the authorized exact-attempt lookup with a bounded closed projection. Callers must gate sending `attemptId` on this flag.
