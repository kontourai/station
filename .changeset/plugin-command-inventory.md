---
'@kontourai/station-contracts': minor
'@kontourai/station-sdk': minor
---

Validate plugin command declarations in both manifest formats and publish them in the installed-plugin inventory. A ready installation's record now carries `commands` and an opaque `installationGeneration` that a command request echoes back; install previews list each command as a `command` component. Declarations that fail validation are dropped and reported as `commandsRejected`; the plugin still loads.
