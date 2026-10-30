---
'@kontourai/station-contracts': minor
'@kontourai/station-sdk': minor
'@kontourai/station-cli': minor
---

Station Automations, observe-only intake: `github-poll` sources are polled on
the scheduler's existing tick, and each completed workflow run is normalized to
the allow-listed fields, deduped, matched against the source's enabled rules
and recorded, with episodes opened and closed. Nothing is started yet. The
contracts add `AutomationDeliveryRecord`; the SDK client adds
`listAutomationDeliveries`; the CLI adds `station automation deliveries`,
served by the read-only `GET /automations/deliveries`.

The Feature Preview is off by default and operator reads require management
access. Delivery and episode updates commit atomically. Poll coverage and
failures are retained in `AutomationDeliveryPage.polls`; a bounded partial page
never advances its cursor or claims complete source coverage.
