---
"@kontourai/station-cli": minor
---

`station plugin install`, `station plugin update` and `station registry install` now exit with status 2, not 0, when Station saved the plugin but it is not active (its activation did not finish and needs recovery, or an older Station did not say). Scripts and agents that treated exit 0 as "installed and usable" now see the difference. A change Station finishes on its own, and a saved `station plugin remove`, still exit 0.

New `station plugin recover <name> [--yes]` recovers a plugin that reads Needs recovery without the Plugins page. It prints the recovery review (contents digest, registry claim, required and awaiting permissions, retained dependencies), requires the same explicit decision as `station plugin install`, and sends exactly the reviewed revisions.
