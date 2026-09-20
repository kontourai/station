---
'@kontourai/station-sdk': patch
---

Allow account-session reads to accept an abort signal so authority-sensitive
guest views can cancel stale requests when the Station or signed-in account
changes.
