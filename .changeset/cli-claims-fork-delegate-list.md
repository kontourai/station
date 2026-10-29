---
"@kontourai/station-sdk": minor
"@kontourai/station-cli": minor
---

Add `listWorkClaims` to the SDK client, the person's read of the work claims of the Sessions they may read. The CLI gains `station claims list`, `station delegate list` (the `list_delegated_tasks` inventory) and `station conversation fork <agent> <conversation-id>` (the web app's fork, with `--target-agent`, `--project`, `--turn` and `--idempotency-key`). Without `--agent` or `--session`, `list` is now a `station delegate` sub-verb (`station delegate list` was a usage error before); a `--session` follow-up that starts with "list" is still sent as a message.
