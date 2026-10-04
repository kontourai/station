---
"@kontourai/station-contracts": minor
---

Claude Code and Codex usage-limit stops now carry the provider's reset time
into connection recovery (`UsageLimitFailureDetails`), so a stop with a known
reset becomes a `wait-until-reset` intent instead of a manual one. A new
`usageLimitAutoResume` setting, off by default, decides whether Station sends
the stopped turn again after the reset. The recovery projection gains
`outcomeReason`, which says why a waiting resume was left to the user or
retired: automatic resume off, a newer turn, an open request, or an ended
Session.
