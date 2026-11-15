---
"@kontourai/station-contracts": minor
"@kontourai/station-cli": patch
---

Add the OpenCode native engine Feature Preview (`opencode-native-engine`, off by default). With it on, new OpenCode 2.x chats run on OpenCode's own server (`opencode serve`) instead of ACP. That adds rewind, queued steering, acknowledged approvals, Station tool servers and image attachments, plus recovery after a dropped event stream. When the server's schema is not one Station has verified, or the server cannot start, a chat falls back to ACP with a warning. OpenCode 1.x always uses ACP. Station's approval modes, tool policy and managed `acp` policy govern native chats the same way they govern ACP chats. With the preview off, nothing changes. `station approvals --agent` now also lists an OpenCode Agent's native chats.
