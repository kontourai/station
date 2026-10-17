---
'@kontourai/station-cli': minor
---

Add explicit source-version requirements to portable delegation with
`--portable-project`, `--resource`, `--source-commit` and `--attempt-id`.
Add receiver-local `delegate attempt` lookup for existing grant-bound claims.
These operations do not transfer files, install dependencies, protect a checkout
against later writers or retry uncertain execution.
