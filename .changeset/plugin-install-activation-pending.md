---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": patch
"@kontourai/station-cli": patch
---

A plugin install that Station accepted but did not finish activating is no longer reported as a failed install. When activation runs past its deadline, `POST /api/plugins/install` answers `202` with `success: false` and `configurationActivation.status: 'pending'`. `usePluginInstallMutation` and `requestPluginRegistryInstallAction` used to throw "Install failed" for that response. They now resolve with the result, and `station plugin install` and `station plugin registry install` print that the plugin is Activation pending and is finished from Plugins → Review recovery.

`@kontourai/station-contracts/plugin` adds `readPluginLifecycleResponse(status, body)` and `pluginLifecyclePending(body)`. These give every caller one reading of applied, pending (`activation` or `projection`) and refused. `PluginInstallResult` gains an optional `configurationActivation` field, and `recoverPlugin` reads its response through the same function. A `202` that does not say pending is still a refusal.
