---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Operators can turn on Project sharing with built-in local accounts from Settings → System. `@kontourai/station-contracts/local-accounts` adds the `AccountSharingSettingView` and `AccountSharingChoice` shapes, and `@kontourai/station-sdk/local-accounts` adds `getAccountSharingSetting` and `applyAccountSharingSetting`. Deployment environment variables still take precedence over the setting.
