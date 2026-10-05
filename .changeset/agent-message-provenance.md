---
'@kontourai/station-contracts': minor
'@kontourai/station-shared': minor
---

A message one agent sends to another Session (`send_to_session`) now carries
who sent it, and never reads as the person's (#3419).

`ClientOrigin` gains an optional `sender` (`ClientOriginSender`, kind
`agent-session`: the sending Session's id, title, Agent and engine, and the
call's `requestKey`), stamped by the server beside the unchanged `actor`, with
`clientOriginSender` to read it. `ConversationMessage.metadata.sender` carries
it onto the transcript row, and `read_conversation` returns it on the message.
The receiving engine is given the text under a fixed header naming the sender
and not the person, with every line of the text quoted
(`@kontourai/station-shared/agent-message-frame`); the transcript shows the
sender's own words. The chat and Activity transcripts show such a message as a
third speaker, with a header, icon and accent derived from the sender, linking
to the sending Session, and the sender's transcript shows the call as "Sent to
<Session>" with its outcome.
