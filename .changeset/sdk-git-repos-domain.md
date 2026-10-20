---
"@kontourai/station-sdk": minor
---

Publish the git and repository domain for plug-ins: `useReposQuery`, `useGitBranchesQuery`, `useGitCheckoutMutation`, `useGitCommitMutation` and `useGitPushMutation`, with the `DiscoveredRepo`, `ReposLocation`, `ReposResult`, `GitBranch`, `GitCheckoutResult`, `GitCommitResult` and `GitPushResult` types. Every hook takes a location object, `{ projectSlug, workingDir }`, like `useGitStatusQuery`; repository discovery's `projectSlug` is optional. Station's Coding toolbar and New Project form now use them. Commit and push stay operator-only on the server, and a refused write rejects with the server's own message.
