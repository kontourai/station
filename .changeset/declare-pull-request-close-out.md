---
"@kontourai/station-contracts": minor
---

`TaskRecord` gains an optional `closeOnMerge` flag: a person's opt-in to move the Task to `done` once every pull request kept on it is merged at its provider. A pull request closed without merging does not complete the Task. The flag is set with `PUT /api/tasks/:taskId/close-on-merge` by a person, never by an agent tool. A Task closes only from a status that may reach `done` (never from todo, ready, triage or blocked), the check runs when an operate-tier viewer refreshes the Conversation's pull request links (nothing polls), and un-keeping an unmerged pull request lets the merged rest close it. Older Station builds refuse a Task store that carries the flag, so clear it before a rollback.

The Station Control `declare_pull_request` tool lets an agent on any engine (Claude Code, Codex, ACP) declare a pull request it opened, in the exact identity shape the conversation link routes accept. It writes the same declared-output record Station's own engine writes with `declare_output`, in the caller's own session and running turn: it is held for as long as the turn runs and lands when the turn completes. It is dropped if the turn aborts, is interrupted or ends in an error, or if Station restarts before the turn completes. A person still keeps a declared pull request onto a Task.
