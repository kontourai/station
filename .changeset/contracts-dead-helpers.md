---
"@kontourai/station-contracts": minor
---

Remove `formatMcpToolRef` from `@kontourai/station-contracts/layout` and `canInstallRegistryItem` and `canRemoveRegistryItem` from `@kontourai/station-contracts/registry-lifecycle`. No Station surface called them. `parseMcpToolRef`, `isValidMcpToolRef` and the registry lifecycle types are unchanged; a caller that formatted a ref should build `${serverId}/${toolName}` and check it with `isValidMcpToolRef`.
