---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Pull request agent feedback can be turned on once for a Project. Contracts add `ProjectPullRequestFeedbackDefaults`, `PullRequestByHead` and `PullRequestsByHeadResult`, and the optional `IPullRequestProvider.findOpenPullRequestsByHead`. The SDK adds `getProjectPullRequestFeedbackDefaults`, `writeProjectPullRequestFeedbackDefaults` and `removeDerivedPullRequest`.
