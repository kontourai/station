---
'@kontourai/station-cli': patch
---

Add `station delegate wait <task-id>` — bounded, observation-only completion
waiting for delegated tasks (#2264). It polls the canonical delegation status
API until an honest outcome and never dispatches, restarts, approves, or
interrupts the delegated provider. `--timeout=<seconds>` (default 3600, max
86400) and `--interval=<seconds>` (default 5, max 3600) are validated before
any request; each status read is bounded by the remaining wait budget.
Outcomes are distinguishable via `data.outcome` and delegate-scoped exit
codes: completed (0), failed/canceled (3), needs-action (4), wait deadline
with the task still running (5), unknown status (6), observation lost (2),
Ctrl-C (130). Under `--json` exactly one envelope is printed.
