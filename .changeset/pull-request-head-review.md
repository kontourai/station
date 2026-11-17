---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Review each new pull request head. Contracts add `pullRequestFeedbackActive(settings, headReview)` (a sending switch, or `reviewEachHead` while review of each head is offered), `PULL_REQUEST_HEAD_REVIEW_PREVIEW_ID`, `PullRequestHeadReview` (with `current`), `PullRequestHeadReviewFinding` and `PullRequestHeadReviewWaiting`, and optional `headReview` and `headReviewWaiting` on `PullRequestFeedbackByPullRequest` and `PullRequestFeedbackView`. The SDK adds `reviewPullRequestHeadAgain`, `sendPullRequestHeadReviewFindings` and `pullRequestHeadReviewRefusal`, and `writePullRequestFeedback` accepts an optional `reviewEachHead`; leaving it out keeps the chat's stored value.
