---
"@kontourai/station-contracts": minor
---

The pull-request review snapshot (`pull-request-provider`) gains two optional
observations from the forge. `checks` is a `PullRequestChecksObservation`:
`available` with `PullRequestCheck[]` (`name`, `state` of
`PullRequestCheckState`, optional `group` and `url`) and `partial`, or
`unavailable` with a reason; GitHub's check runs and commit statuses and
GitLab's head pipeline are its sources, and a gh that cannot report the
field answers `unavailable`. `reviewComments` is a
`PullRequestReviewCommentsObservation`: `available` with
`PullRequestReviewComment[]` (`id`, `author`, `body`, `createdAt`, `path`,
`side` of `additions` or `deletions`, `subject` of `line` or `file`, `line`
null once the forge no longer maps the comment or when the subject is the
file, optional `inReplyTo` and `url`) and `partial`, or
`unavailable` with a reason. Either field absent means the server did not
observe it; neither is an empty list standing in for none. The existing
`mergeability` on the pull request is what the review pane now states beside
them.
