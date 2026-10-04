---
"@kontourai/station-contracts": patch
---

A conversation that stopped on a provider usage limit now shows a banner above
the composer: "Usage limit reached · Resets <local time>", or plain manual
wording when the provider gave no reset. It offers Resume now, which starts
sending the stopped turn again at once, and Cancel auto-resume while an
automatic resume waits. With the setting off it says so, and Resume now is
still offered, with a note that the limit may not have reset yet. A stop that
settles (a newer message, an open request, an ended Session, Cancel, or a
resume that failed) says why, briefly, and never offers a stale action. A
resume the provider refuses again keeps the wait for the reset, when that reset
is at least a minute away, up to three times in a row. The recovery projection gains the `user-canceled`
reason, and Sessions gain
`GET /api/orchestration/sessions/:threadId/usage-limit` plus person-owned
`POST .../usage-limit/resume` and `.../usage-limit/cancel`.
