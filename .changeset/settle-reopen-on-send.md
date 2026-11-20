---
"@kontourai/station-contracts": patch
"@kontourai/station-cli": minor
---

Add `station conversation settle <conversationId>` and
`station conversation reopen <conversationId>`, which move a conversation
between Open and Settled in your own inbox under the Open and Settled inbox
Feature Preview (`PUT /api/conversations/:id/work-state`). The contracts
package adds the activity phrase for Station Control's `settle_conversation`
tool.
