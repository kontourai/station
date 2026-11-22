---
"@kontourai/station-cli": minor
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Add `station acp setup` and the safe `ACPEngineSetupEntry` catalog contract for guided engine setup. Engine setup links lead to Station's existing connection and sign-in pane; installation and credential operations stay with the person. ACP command-catalog actions reject an engine id instead of implying they check that engine.

The `@kontourai/station-sdk/engine-setup` entry provides scoped installer and Agent-tool hooks. The guided pane reviews and runs built-in installers in a visible terminal, verifies device-code sign-in, repairs launch arguments in place, and explicitly selects Station tools while preserving authored settings. Installer retries reconcile the saved attempt; Stop targets that exact attempt. The supervisor's protocol 1.4 negotiates a process-owned lifetime before starting a bounded command.
