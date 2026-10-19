---
'@kontourai/station-contracts': minor
'@kontourai/station-sdk': minor
---

A follow-up sent to a busy conversation can be held by Station instead of
refused (#3568). `POST /api/orchestration/chat` with `whenBusy: 'queue'`
answers `202` with a `ConversationInboxQueuedReceipt` when the conversation's
turn is running, and Station sends the message itself when that turn ends,
across a closed app, another device or a restart. `TurnDeliveryInspection`
gains the `queued` outcome, and the new `ConversationInboxEntry` describes a
held message. The SDK adds `queueExecutionMessage`, `listConversationInbox` and
`cancelConversationInboxEntry`. Contracts export
`CONTINUATION_WORKSPACE_REFUSAL_CODES`, the codes a continuation refused for
its persisted workspace answers with (and a held message's `reasonCode`).
A refused send whose key another attempt still holds (`client_turn_in_flight`)
now answers `409` rather than `400` on `/chat` and `/chat/:id/continue`; the
code is unchanged and still means retry with the same key. A Station that predates the inbox ignores
`whenBusy` and refuses a busy send as before, so keep the message on that
refusal.
