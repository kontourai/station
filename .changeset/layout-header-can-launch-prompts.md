---
"@kontourai/station-sdk": patch
---

LayoutHeader: `canLaunchPrompts`. An optional prop a host sets to `false` when it has no prompt launcher; the header then renders no prompt action, global skill, tab prompt or quick-actions menu instead of rendering them wired to a no-op. `external` and `internal` actions still render. Absent keeps the previous behaviour.
