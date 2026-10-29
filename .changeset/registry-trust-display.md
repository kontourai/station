---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Plugin preview and `listPlugins` rows carry the host-persisted registry receipt as `registryTrust` (verified receipt and pin, `none`, or `unavailable`). `RegistryAcquisitionReceipt`, `PluginRegistryTrust` and their exact-shape checks are exported from `@kontourai/station-contracts/registry-trust`.
