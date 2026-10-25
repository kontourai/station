---
'@kontourai/station-sdk': minor
---

Give direct chat streams a default turn key, preserve that key on results and through the sentTurnKey error accessor, and use it for stable message IDs. Treat response parse errors as uncertain delivery rather than proof that a request was never sent.
