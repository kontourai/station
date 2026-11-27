---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
"@kontourai/station-shared": minor
---

Pull request agent feedback that needs a person shows in Needs you. Contracts add the `pull-request-feedback` attention item (`PullRequestFeedbackAttentionItem`), `cap` and `at` on a paused feedback status, and a `pull-request-feedback` client-origin sender so the delivered message is labelled as Station's. The SDK adds `turnOffPullRequestFeedback` and exports the new item type. Shared ranks the `pull-request-feedback` notification category as needing input.
