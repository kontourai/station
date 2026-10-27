---
"@kontourai/station-contracts": minor
"@kontourai/station-cli": minor
"@kontourai/station-sdk": minor
"@kontourai/station-shared": minor
---

Add explicit local operator setup and revocation for selected external Station
Control clients, with independent bounded leases, server-recorded Session and
Project scope, header-only delegated custody, and private CLI configuration.
This does not add remote OAuth, browser-bound authority or engine takeover.

Keep text context across engine changes and fork starts, and refuse ordinary
continuation when its first context delivery fails or cannot be confirmed.
Allow saved forks to reopen before first send and to be deleted safely before
starting an engine.

Confirm a first native identity from its correlated engine completion when it
arrives after turn preparation, while refusing conflicting identities and
preventing later carrier rebinds from borrowing that completion.
