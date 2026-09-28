---
'@kontourai/station-sdk': minor
---

`BrandingData.theme` is now typed `unknown` instead of `Record<string, string>`.
The value is the branding provider's white-label overrides exactly as served
(by convention flat `--k-*` keys for both modes plus per-mode `dark` / `light`
objects), and nothing between the provider and the caller validates it, so a
consumer must parse it before use. `fetchBranding` (and `useBrandingQuery`) now
reject a non-2xx or `success: false` answer instead of resolving it as "no
branding".
