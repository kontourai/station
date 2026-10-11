---
'@kontourai/station-contracts': minor
'@kontourai/station-sdk': minor
---

Monitoring and Insights no longer report figures nothing measured (#463).
`UsageInsights.agentUsage` entries carry only `chats`: the per-agent `tokens`
field was always an unmeasured `0`. The SDK still accepts the legacy field from
older Stations and ignores it. `MonitoringAgentStat.cost` and
`MonitoringStatsData.summary.totalCost` are removed for the same reason.
`MonitoringMetric.totalCost` is now optional and absent when no completion was
priced, and the new optional `MonitoringMetric.unpricedCount` counts the
completions it leaves out.
