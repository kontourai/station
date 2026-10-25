---
'@kontourai/station-sdk': minor
---

Give direct chat streams a default turn key, preserve that key on results and through the sentTurnKey error accessor, and use it for stable message IDs. Treat response parse errors as uncertain delivery rather than proof that a request was never sent.

Supplied keys must be nonblank strings of at most 200 characters; invalid values now fail locally with TypeError. Text-only requests now use the message-array form with a key-derived ID, and successful or actively aborted results require clientTurnId. sentTurnKey returns undefined for primitive throws or an error object shared by different turn keys. isProvablyNotSent no longer treats any SyntaxError as proof that a request was never sent, including errors whose message contains a connection-refusal word.
