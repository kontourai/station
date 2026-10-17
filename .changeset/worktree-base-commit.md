---
'@kontourai/station-contracts': minor
---

Add optional `baseCommit` to owned worktree Session metadata. New worktree
provisioning resolves the configured base ref to a full commit before checkout,
uses that pinned commit, and retains it alongside the original ref. Older
Session records remain valid without a recorded starting commit.
