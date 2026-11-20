---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Show pull request agent feedback wherever a pull request is looked at. Contracts add `PullRequestFeedbackByPullRequest`, an optional `headSha` on a current Task pull request fact, its optional `feedback` (`TaskPullRequestFeedbackFact`), and `TaskLaneDerivation.feedbackNote`, which never changes a lane. `PullRequestFeedbackOwner.conversationId` is now optional: it is absent for a chat the reader may not read. The SDK adds `getPullRequestFeedbackByPullRequest`, and `pullRequestFeedbackOwnerOf` answers `{}` for such a chat instead of `undefined`.
