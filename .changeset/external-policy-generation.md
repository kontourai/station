---
---

Station core only. A running Claude Code, Codex, OpenCode or other ACP engine
session no longer refuses every tool call (`stale_generation`) after an
unrelated Agent, connection, provider or plugin changes. Only a change to that
session's own Agent refuses its tools, and the conversation's next message then
starts a new session under the current definition instead of being refused
again.
