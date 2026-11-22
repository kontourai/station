---
---

Station core only. A running Claude Code, Codex, OpenCode or other ACP engine
session no longer refuses every tool call (`stale_generation`) after an
unrelated Agent, connection, provider or plugin changes. A change to what that
session was launched with (its own Agent, its tool servers and their
definitions, its engine connection) still refuses its tools, and the
conversation's next message now restarts the engine in place under the current
configuration (or starts a successor for an engine that cannot resume) instead
of being refused again.
