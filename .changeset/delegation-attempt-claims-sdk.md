---
'@kontourai/station-sdk': minor
---

Add the opt-in portable delegation attempt correlation: `DelegateTaskInput.attemptId` plus the authorized exact-attempt lookup (`lookupDelegationAttempt` / `DelegationAttemptView`). The view carries the claim state, the reserved receiver task reference for every known claim, and the exact initial turn id when accepted, so a lost acknowledgement resolves to that task and turn without re-POSTing. Never a prompt, path, digest, transcript, or provider output.
