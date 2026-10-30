---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
"@kontourai/station-cli": minor
---

Add Session reads a person can make from the CLI (#3427). `station sessions wait|digest|transcript|search` and `station activity` read your own Sessions with your saved credential, never as an agent. `sessions wait` reports a turn that a Station restart interrupted as `restart-interrupted` (exit 3), never as settled. The SDK adds `waitForSession`, `getSessionDigest` and `listSessionActivity`, gated on the new `sessionPersonReads` capability flag. They throw `SessionReadsUnsupportedError` on a Station that predates them. The wait, digest and activity reads are behind the `session-cli-reads` Feature Preview.
