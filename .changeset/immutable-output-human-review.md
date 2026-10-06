---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Add immutable-version human output reviews to ordered Task room history, with current-authority duplicate receipts and connection-bound SDK hooks. Room readers accept v2 and v3 records; the first review adopts v3 for that room and persistently fences older writers. Reviewer acceptance does not change Task or workflow status.
