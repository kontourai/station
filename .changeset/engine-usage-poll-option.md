---
"@kontourai/station-sdk": minor
---

`useEngineAccountUsageQuery` takes an optional fifth argument, `{ poll }`.
It defaults to `true`, which keeps the existing one-minute refresh; `poll: false`
reads the allowance once per visit, for a surface that lists many engines at
once (the Connections Overview).
