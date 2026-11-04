---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Add the `project-checkout-freshness` contract subpath: how far a Project's checkout is behind its upstream branch, read from local git refs, with the thresholds that make it stale and the update command. It also adds the `checkoutStaleAfterCommits` and `checkoutStaleAfterDays` Station settings. The SDK adds `getProjectCheckoutFreshness` and `useProjectCheckoutFreshnessQuery`, which answer `null` when the host does not offer the read.
