---
'@kontourai/station-sdk': minor
---

Give direct chat streams a default turn key, preserve that key on results and through the sentTurnKey error accessor, and use it for stable message IDs. Treat response parse errors as uncertain delivery rather than proof that a request was never sent.

Refusing a same-key retry after an invoked attempt fails, is cancelled or loses its client requires a Station server build containing [#4191](https://github.com/kontourai/station/commit/82b0727539d0b585cfd4f986073649b495501e00); retaining the SDK key alone does not establish that server protection.

Supplied keys must be nonblank strings of at most 200 characters; invalid values now fail locally with TypeError. Text-only requests now use the message-array form with a key-derived ID, and successful or actively aborted results require clientTurnId. sentTurnKey returns undefined for primitive throws or an error object shared by different turn keys. isProvablyNotSent no longer treats any SyntaxError as proof that a request was never sent, including errors whose message contains a connection-refusal word.

Any error object recorded by a keyed direct-chat call is conservatively classified as uncertain, including read-only refusals before network dispatch and abort reasons later reused by another SDK call. Callers retain their original key when deciding what to inspect or retry.

Fetch-time SyntaxErrors in launchScheduledCheckStarter now produce ScheduledCheckStarterResponseError with the original operationId and cause. In adoptOrchestrationSession they produce AdoptSessionError with failureClass uncertain-no-response rather than certain-not-sent. New integrations should use the orchestration sendExecutionMessage API; the legacy streamConversationTurn export still targets Station's private compatibility route.
