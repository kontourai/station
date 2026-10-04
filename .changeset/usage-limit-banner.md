---
"@kontourai/station-contracts": patch
---

A conversation that stopped on a provider usage limit now shows a banner above
the composer: "Usage limit reached · Resets <local time>", or plain manual
wording when the provider gave no reset. It offers Resume now, which sends the
stopped turn again at once, and Cancel auto-resume while an automatic resume
waits; with the setting off it says so and offers Resume now once the reset has
passed. A stop that settles (a newer message, an open request, an ended
Session, or Cancel) says why, briefly, and never offers a stale action. The
recovery projection gains the `user-canceled` reason, and Sessions gain
`GET /api/orchestration/sessions/:threadId/usage-limit` plus person-owned
`POST .../usage-limit/resume` and `.../usage-limit/cancel`.
