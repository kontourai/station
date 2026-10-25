---
---

Record an install trust decision for every plugin install and update in `plugin-trust.json`, and grandfather plugins installed before it at tier 2 (#2998, part 2a). The tier is not enforced until per-plugin renderer capabilities ship. If the first write of `plugin-trust.json` fails, the next attempt rebuilds it; once written, a missing file refuses installs with a 503 that names the recovery. More than 1024 pre-existing plugins are not grandfathered. Records carry a version, and an install over a record written by a newer Station is refused with 409 `plugin-trust-record-newer`. The registry install and managed update routes answer install trust refusals with the same status and code as the direct install.
