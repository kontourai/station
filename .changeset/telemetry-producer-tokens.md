---
'@kontourai/station-cli': minor
'@kontourai/station-sdk': minor
'@kontourai/station-contracts': minor
---

Add telemetry producer tokens for external monitoring producers. The CLI gains `station telemetry producers create|list|revoke` and a `--producer=<name>` filter on `station insights get` and `station insights events`. The SDK's `InsightsFilters` and `MonitoringEventFilters` take `producer`, and its Insights response carries `producerActivity` and `applied.producer`, which the `UsageInsights` contract now declares.
