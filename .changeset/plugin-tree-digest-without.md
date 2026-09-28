---
'@kontourai/station-shared': minor
'@kontourai/station-sdk': minor
---

`observePluginTreeAsync` can also report, from the same walk, the digest of a
tree with some named entries left out. `PluginInstallConsent` gains an optional
`gitMetadata: 'excluded'`, echoing a preview that staged the source without its
git metadata so the install stages it the same way.
