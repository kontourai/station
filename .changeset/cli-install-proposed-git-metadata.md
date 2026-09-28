---
'@kontourai/station-cli': patch
---

`station install <path>` sends back the preview's `gitMetadata`, so a folder
Station stages without its git metadata (one a proposal names, or one already
installed that way) installs instead of being refused.
