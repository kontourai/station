---
'@kontourai/station-contracts': minor
'@kontourai/station-sdk': minor
'@kontourai/station-cli': minor
---

A recorded approval decision is now reported apart from whether the engine
acknowledged it (#2880). Contracts: `request.resolved` gains an optional
`acknowledgement` (`engine`, `in-process` or `none`), and a new
`request.delivery` event (`acknowledged` or `unacknowledged`, with
`reason: 'no-acknowledgement' | 'invalid-reply'`) joins
`CanonicalRuntimeEvent`. SDK: `DelegatedTaskSnapshot` gains `lastDecision`
and `earlierUnacknowledgedDecisions` (`DelegatedTaskDecision`), whose
`delivery` is `awaiting-acknowledgement`, `acknowledged`, `unacknowledged`,
`in-process`, `closed-by-engine` or `not-reported`. Both unions are new
values for existing consumers: an exhaustive `switch` over
`CanonicalRuntimeEvent['method']` or over `delivery` needs a case (or a
default) for them. CLI: `station delegate status` prints one line per
decision, including earlier unacknowledged ones and requests the engine
closed before Station answered.
