# Houston: your personal agent

Houston is one chat you keep as your personal agent. You can hand it work,
leave, and pick it up again from your desktop or your phone. Station tells
Houston when your work needs you, fails or finishes, so it can check what
happened and bring you the result or the decision.

> The names Houston and Mission Control are working names, pending a
> trademark check. Station's routes and settings call it the *coordinator*.

## Set up Houston

1. Open a chat on a supported engine.
2. Open the chat's **More** menu (the **⋯** sheet on a phone) and choose
   **Make this Houston**.

Home (Mission Control) now shows a **Houston** card with **Talk to Houston**,
which opens that chat. You have one Houston. If another chat already is,
the menu offers **Make this Houston instead**, which replaces it. **Stop using
as Houston** removes it. If you delete Houston's chat, you can choose another
without replacing anything.

Houston gets Station's own tools (Station Control) whatever Agent it runs, so
it can delegate work to other engines, read Sessions and Tasks, and message
you. An ACP agent receives them only if it supports HTTP MCP servers;
otherwise the chat works without them and Station records that they were not
delivered. The tools arrive when Houston's next session starts. If the chat
was already running when you chose it, Station says so, and the Houston card
reads "Station tools arrive with its next session" until then.

Houston acts with your normal permissions and approval mode, and asks you for
approvals as any chat does. Anything your Agent configures, including its own
auto-approvals, still applies.

## When Houston is woken

Station sends Houston a short message from Station (not from you) when work
you can read:

- **needs you**: an approval or question is waiting;
- **failed**;
- **finished**.

The message names each Session. Houston should read the Session's output
before telling you anything, rather than trust the status.

Station keeps this from getting noisy:

| Limit | Value |
| --- | --- |
| Gathered before one message is sent | 30 seconds |
| Messages per hour | 12; anything past that waits for the next free slot |
| Sessions named in one message | 10, then a count of the rest |
| Items waiting at once | 100; newer ones still show in your Attention |
| An item already sent | not sent again for 7 days |

If Station can't hand a message over (Houston's chat is full, or something
failed), it tries again after 1 minute, then 5, then 15, then every hour. Each
try counts toward the hourly limit, and a restart keeps the schedule.

Houston's own turns don't wake it. Work it delegated itself doesn't wake it
when it finishes or fails, because that result already comes back to it
directly; if that work needs you, Houston is told. A message waits for
Houston's current turn to finish; it never interrupts it.

Station checks that you can read each Session when it prepares a message,
and again just before Houston's chat receives it. A message naming a Session
you can no longer read is not delivered; the rest go out in a new message. A
message that has waited more than 24 hours for Houston's chat is not delivered
at all. When you stop using a chat as Houston (or replace it), all messages
still waiting for that chat are withdrawn together.

## Working picture

Turn on **Coordinator working picture** in Settings → Advanced → Feature
previews to let Houston keep a short picture of work in flight, waiting on you
and recently finished. Home shows notes for conversations you can still read.
The picture follows you when you replace Houston; finished notes show for
seven days and are removed when a later update is saved. Houston maintains the notes, so check the underlying work for its
current state.

## Limits

- Requested stops, pairing requests and scheduler notices don't wake Houston.
  Only work that names a Session does.
- A message that is already being delivered can't be withdrawn.
- A hosted Station has no Houston.
- Houston doesn't keep a separate record of your Projects yet. It works from
  its own conversation and what it reads from Station.

See the [glossary](../glossary.md) entry *Coordinator Session* and the
[decision record](../decisions/personal-coordinator-session.md).
