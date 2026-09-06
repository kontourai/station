---
"@kontourai/station-contracts": minor
---

Add the `project` skill origin, so a workspace-scoped skill is distinguishable from a machine-wide one. Both are writable roots and previously reported `user`, which left no reader able to name the difference. Command-claim precedence places `project` in the same tier as `user`, matching the order discovery already resolves a name collision by.
