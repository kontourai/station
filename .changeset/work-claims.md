---
'@kontourai/station-contracts': minor
---

`@kontourai/station-contracts/work-claims` is new: `WorkClaimView`, the work
claim Station's routes answer with, its `parseWorkClaimView` boundary parser,
`workClaimSubjectLabel` (the short label a row shows) and
`workClaimSubjectDetail` (everything a claim names).

Station Control gains `claim_work`, `renew_claim` and `release_claim`
(station#3413). A Session says what it is on (a work item reference, paths, or
both, with a one-line note) so other Sessions in its Project see it in
`list_project_activity`, which now lists each Session's active claims, and in
the Station UI's Session rows. A claim is information, not a lock: other
Sessions may claim the same item. It expires after `ttlSeconds` (default 1800,
60 to 14400) unless renewed, its claimant may release it with a note, and it
stops showing once the claimant Session ends. The claimant is always the
calling Session; another Session's claim id reads as `claim_not_found`. A
Session holds at most 10 active claims, a claim names at most 20 paths, and a
value past a bound is refused, never cut. Claims belong to the claimant's
Project (or the global space) and carry the Task id when the Session was
dispatched for a Task.
