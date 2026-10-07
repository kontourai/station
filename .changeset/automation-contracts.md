---
'@kontourai/station-contracts': minor
---

Add the `@kontourai/station-contracts/automation` subpath for Station
Automations: GitHub poll and webhook sources with an API-safe projection that
omits the webhook secret, source grants, exact-equality matchers, rules,
episode policies, the closed `AutomationDeliveryOutcome` union,
`AUTOMATION_EXECUTION_LIMITS`, `GITHUB_AUTOMATION_EVENT_ALLOWLIST` (initially
`workflow_run` `completed`) and the `AUTOMATION_OPERATOR_SURFACE` parity table.
Mutating operator verbs have no station-control MCP name, so an agent cannot
create or widen its own triggers. The types are published ahead of any route,
intake or dispatch that consumes them.
