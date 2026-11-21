---
status: current
subject: A Task that keeps a pull request watches it until it lands; merging stays with the person
decided: 2026-11-17
evidence:
  - kind: issue
    ref: https://github.com/kontourai/station/issues/5066
  - kind: doc
    ref: docs/decisions/pull-request-agent-feedback.md
  - kind: doc
    ref: src-server/services/pull-requests/pull-request-watch.ts
---

# A Task that keeps a pull request watches it until it lands

A Project can have its Tasks watch the pull requests kept on them (Project
settings → **Pull requests**), and each Task can override that (**Watch pull
requests** / **Stop watching** on the Task). A watching Task wakes its agent
when CI fails or a reviewer writes, counts the fix attempts it sends, reports
when the pull request is ready for the person, and refuses the agent anything
that would take merging away from the person. Everything sits behind the
`pull-request-agent-feedback` Feature Preview and its `pullRequestFeedback`
capability flag, so hosted Stations do not offer it.

## Decisions

1. **One loop, not a second one.** Watching is a claim on the
   [pull request agent feedback](pull-request-agent-feedback.md) loop, owned
   by the Task's chat and marked with the Task. That loop already wakes an
   idle agent only on a failing check, an unresolved review thread or a
   change request, records each distinct item once (so the same event never
   wakes twice), holds while the agent works, and reads the forge on the
   built-in scheduler's existing tick. There is no model polling loop.
2. **Who watches.** A Task's own choice (`TaskRecord.pullRequestWatch`, `on`
   or `off`) wins; absent, its Project's (`ProjectConfig.pullRequestWatch`).
   Only a person sets either: no Station Control tool names the routes, so the
   central authority guard refuses an agent, and the Project route admits only
   its owner. A done or canceled Task watches nothing.
3. **Claims are created, never taken.** A watching Task claims a kept pull
   request only when no chat owns its feedback. A claim a person made in a
   chat stays theirs; a person turning feedback off in a chat clears the
   Task's mark, so the Task does not turn it back on. Stop watching releases
   the Task's claims and keeps the mark, so watching again resumes them.
4. **Budget.** Each placed message that carried a pull request's failing
   checks is one fix attempt (default 3, at most 10 per Project). When a new
   failing head finds them all used, the claim pauses (`fix-budget`) instead
   of sending, and Station moves the Task to `blocked` with the failing checks
   and pull request named (`TaskRecord.pullRequestWatchHold`). The board shows
   it under **Needs you** as **Fix attempts used**, and the pause raises the
   feedback loop's one Agent feedback item in Needs you and one push to the
   chat's readers, with Send again. Any status change clears
   the hold. **Send again** on the pull request grants one more attempt. The
   budget replaces the feedback loop's repeated-failure pause for watched pull
   requests; the 3-rounds-per-head and 10-per-day caps still apply.
5. **Ready for the person.** Once per head, when the agent is idle and the
   forge shows the pull request open, not a draft, not conflicting, every
   check finished with none failing (all read), no unresolved current thread
   and no change request, the Task's watch reads **Ready for you**.
   When **Review each new head** is on, it also waits for that head's
   completed Station review with no required findings. The Task panel shows
   pending review or the next recovery step, including dismissed findings,
   a pause or a review owner who can no longer send to the chat. Changing
   review settings in the same chat keeps the watch and its fix budget.
6. **Refusals are enforced, not prompted.** A pre-tool policy stage, ahead of
   every grant (full access included), reads each shell and file-write call a
   watching Task's agent makes. `gh pr merge` (with or without `--auto`),
   GitHub's auto-merge mutation, `glab mr merge`, and a force-push (`--force`,
   `--force-with-lease`, `-f`, `--mirror`, a `+` refspec) are refused. A write
   to CI configuration (`.github/workflows/`, `.github/actions/`,
   `.gitlab-ci.yml`, `.circleci/`, Azure, Bitbucket, Travis, Buildkite,
   `Jenkinsfile`) is put to a person as a required question. Each one is
   recorded on the Task (30 days) and listed under **Refused actions**.

## Limits

- The refusal reads the call, not its effect. A script file, a variable, an
  alias or `eval` is not seen into. It stops the direct forms an agent writes;
  it is not a sandbox.
- Engines reach the stage through Station's pre-tool policy: Station's own
  engine, Claude Code (its `PreToolUse` hook) and ACP engines such as
  OpenCode. Codex passes only Station's own tools through that policy; its
  shell commands go through Codex's sandbox and approvals, so a Codex agent's
  `gh pr merge --auto` or force-push is not refused by this stage. An engine
  that runs with no Station policy hook is not covered either.
- Not built: a post in the Project Room, and a push notification when a pull
  request is ready. Ready is reported on the Task's own **Pull request watch**
  panel and by the board's existing Ready to merge lane; a spent budget also
  notifies (decision 4). Work-item sync (#3703)
  reads the Task's `blocked` status like any other.
