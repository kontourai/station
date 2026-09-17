---
"@kontourai/station-shared": patch
"@kontourai/station-cli": patch
---

Keep plugin builds from reinstalling a containing Station workspace. Root-managed
plugins use the managed dependency bootstrap; standalone nested plugins install
only into their own directory, preserving the host's lock and dependencies.
