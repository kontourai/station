---
'@kontourai/station-sdk': patch
---

Depends on `@kontourai/ui` `^1.18.0` (was `^1.16.0`), so the workspace resolves
one version of the design kit. The SDK's own use of it (`Empty`) is unchanged.

Behaviour change for white-label branding providers, in the Station app that
ships with this release: `@kontourai/ui` 1.18 rates `--k-brand` as text at
4.5:1 on the raised panel as well as on the page and the panel. A dark-mode
brand that cleared the page and the panel but is under 4.5:1 on the dark
raised panel `#16202d` (relative luminance from about 0.2155 up to 0.2377, for
example `#9364ff` or `#007efa`) was accepted before and is now rejected.
Acceptance is all or nothing, so such a theme falls back to the default
colours in both modes until the dark brand is lightened. Each rejection is
logged in the browser console with a `[branding-theme]` prefix, naming the
value, the surface and the ratio it needs. Light-mode brands are unaffected.
