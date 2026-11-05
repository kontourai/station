---
'@kontourai/station-contracts': minor
'@kontourai/station-sdk': minor
'@kontourai/station-cli': minor
---

Automation rules have a per-rule mode (#4509): `off`, `observe` or `live`.
New rules start in `observe`. An `observe` rule is evaluated at intake against
current `live` load (match, episode, global concurrency, its active limit and
`maxStartsPerHour`; its own would-starts never count as active work). It never
retains an intent, opens an episode or consumes an attempt, so neither the Task
runtime nor isolated repairs can start work for it. Observing still polls the
rule's enabled source and takes each observed run's dedupe key, so switching it
to `live` acts only on later events.

Breaking for type consumers: `AutomationRule.enabled` is replaced by
`mode: AutomationRuleMode`. A stored configuration written before this change
still loads; `enabled: true` reads as `live` and `false` as `off`. Downgrade:
once this version writes the file, an older Station reads the whole Automation
configuration as `policy_unavailable` (fails closed; nothing polls or
dispatches) until the rules are restored to `enabled`.

`AutomationDeliveryRecord` gains optional `decisions` (`AutomationRuleDecision`:
mode, `would-start` / `suppressed` with a reason / `intent-retained`, and a
bounded rule, action, Project, Agent and episode snapshot). The SDK's
`listAutomationDeliveries` and `station automation deliveries` return them.
`AUTOMATION_SUPPRESSION_REASONS` adds `rule-active-limit` and
`concurrency-limit`.
