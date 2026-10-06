---
'@kontourai/station-sdk': patch
---

`KnowledgeRecordDetail` offers line breaks in a record title at identifier
word boundaries (a lower-to-upper case change, or after `.`, `_`, `/` or `-`),
so a narrow heading wraps `KnowledgeStoreProvider` as `KnowledgeStore` /
`Provider` instead of at whichever letter overflows. The title text is
unchanged.
