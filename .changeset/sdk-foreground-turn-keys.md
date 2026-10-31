---
"@kontourai/station-sdk": minor
---

Choose and preserve a turn key for foreground sends, continuations and the orchestration query wrapper. Successful calls return a `KeyedForegroundMessageReceipt` with the chosen `clientTurnId`; supplied keys are validated before any request. The SDK does not retry automatically.

`sentTurnKey(error)` now covers these calls, preserving the original thrown object and the shared ambiguity rule. Their recorded failures, including read-only and visual-skill preflight refusals, are conservatively excluded from `isProvablyNotSent`. Server digest enforcement and retention remain separate from SDK key custody.

For new-conversation retry, retain a caller-selected `conversationId` too. Current servers allocate a fresh conversation per attempt when it is omitted, so turn-key custody alone does not make that start retry-safe.
