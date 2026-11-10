---
"@kontourai/station-cli": patch
---

Fix command-line defects: `plugin dev` awaits dependency installs, `supervisor <unknown>` no longer runs `status`, `registry` refuses a flag as its URL and never replaces an unparsable `app.json`, `--home=` selects an instance like `--base=`, and `target` treats `http://[::1]` as local. Flags that silently ignored the spaced form (`--flag value`) and numeric values such as `7abc` now fail with a clear error. `checkpoints restore` uses the standard Station target and credential resolution. Copy-paste command hints are quoted for the current platform and leave plain ids unquoted.
