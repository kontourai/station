---
"@kontourai/station-sdk": patch
---

Partition tool-library query results by both Station request authority and the pinned person. Changing accounts with the same Station connection no longer exposes the previous account's cached catalog while the new read is pending or lets a late old response populate the current reader.
