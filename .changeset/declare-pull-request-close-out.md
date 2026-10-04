---
"@kontourai/station-contracts": minor
---

`TaskRecord` gains an optional `closeOnMerge` flag: a person's opt-in to move the Task to `done` once every pull request kept on it is merged at its provider. A pull request closed without merging does not complete the Task. The flag is set with `PUT /api/tasks/:taskId/close-on-merge` by a person, never by an agent tool, and older Station builds refuse a Task store that carries it.

The Station Control `declare_pull_request` tool lets an agent on any engine (Claude Code, Codex, ACP) declare a pull request it opened, in the exact identity shape the conversation link routes accept. It writes the same declared-output record Station's own engine writes with `declare_output`, in the caller's own session and running turn: it lands when the turn completes and is dropped if the turn aborts. A person still keeps a declared pull request onto a Task.
