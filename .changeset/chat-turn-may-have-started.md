---
"@kontourai/station-sdk": patch
---

`streamConversationTurn` reports a direct `/chat` turn that may already have
reached the agent (#3581). When Station refuses a retried `clientTurnId`
because an earlier attempt passed its invocation point before Station
stopped, or because its result is no longer kept, the rejected `ChatHttpError`
carries `code: 'foreground_message_indeterminate'` and
`outcome: 'indeterminate'`. Do not resend such a turn automatically. Other
refusals leave `outcome` unset.
