---
"@kontourai/station-shared": patch
---

The home schema gate accepts a fresh home that holds only the process supervisor's `run` directory, so the first core server generation a supervisor starts can bootstrap the home. A `run` that is a file or a symlink, or application data beside it, still requires a reset.
