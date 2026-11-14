---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Add the optional, deny-only `queuedFollowUp: { state: 'none', detail: string }`
durability cell and support it in SDK conversation-open decoding. Its absence
keeps existing Queue behavior; server admission is still required.

Older SDK readers with a closed durability-profile field set may reject
restricted Sessions that declare this cell. Update those clients before opening
these Sessions. Sealed Sessions explain that another turn must use the report
or group controls.
