---
'@kontourai/station-contracts': minor
'@kontourai/station-sdk': minor
---

Add a narrow branch-mergeability read for conflict indicators (#2937). `@kontourai/station-contracts/pull-request-provider` exports `PullRequestBranchMergeability` and an optional `IPullRequestProvider.listOpenPullRequestMergeability`. The SDK exports `usePullRequestMergeabilityQuery` and `pullRequestMergeabilityQueryKey`, keyed by project and repository rather than session, and re-exports the `PullRequestBranchMergeability` type. `QueryConfig` gains an optional `refetchOnWindowFocus` so a slowly polled read can refresh a stale answer when the window returns.
