---
"@kontourai/station-cli": patch
---

`station approvals list` no longer requires `--agent=<slug>`. Without it, the command lists pending approval requests from every session on the Station; with it, the list is narrowed to that Agent's engine as before. `station approvals --help` now shows the real flags (`--agent`, `--thread`, `--watch`) and the thread id that `respond` takes. `station checkpoints --help` now lists its actions.
