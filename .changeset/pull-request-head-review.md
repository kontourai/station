---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Review each new pull request head. Contracts add `pullRequestFeedbackActive` (a sending switch or `reviewEachHead` on), `PULL_REQUEST_HEAD_REVIEW_PREVIEW_ID`, `PullRequestHeadReview` and `PullRequestHeadReviewFinding`, and an optional `headReview` on `PullRequestFeedbackByPullRequest` and `PullRequestFeedbackView`. The SDK adds `reviewPullRequestHeadAgain` and `sendPullRequestHeadReviewFindings`, and `writePullRequestFeedback` accepts an optional `reviewEachHead`; leaving it out keeps the chat's stored value.
