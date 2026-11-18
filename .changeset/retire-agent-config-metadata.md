---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
"@kontourai/station-shared": minor
---

Remove `streaming` and `ui.quickPrompts` from the Agent authoring type and schema. Remove those keys from new definitions. Existing files still open with their bytes intact, and the next save writes the current shape. Agent guidance import and export omit both fields. Layouts can continue passing `AgentQuickPrompt` to `onLaunchPrompt`.
