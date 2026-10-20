---
"@kontourai/station-sdk": minor
---

Publish the git and repository domain for plug-ins: `useReposQuery`, `useGitBranchesQuery`, `useGitCheckoutMutation`, `useGitCommitMutation` and `useGitPushMutation`, with the `DiscoveredRepo`, `ReposResult`, `GitBranch`, `GitCheckoutResult`, `GitCommitResult` and `GitPushResult` types. Station's Coding toolbar and New Project form now use them. Commit and push stay operator-only on the server, and a refused write rejects with the server's own message.
