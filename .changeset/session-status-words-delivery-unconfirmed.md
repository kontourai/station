---
"@kontourai/station-contracts": minor
---

`SESSION_STATUS_WORDS` no longer lists `'delivery-unconfirmed'` ("Delivery unconfirmed"). No status derivation returns it: a chat whose last message may not have arrived keeps its own status and carries that as a flag on its row. A consumer that read the entry by name should drop that branch; `sessionLadderWord` never returned it.
