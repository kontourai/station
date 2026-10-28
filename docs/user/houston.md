# Houston: your personal agent

Houston is one chat you keep as your personal agent. You can hand it work,
leave, and pick it up again from your desktop or your phone. Station tells
Houston when your work needs you, fails or finishes, so it can check what
happened and bring you the result or the decision.

> The names Houston and Mission Control are working names, pending a
> trademark check. Station's routes and settings call it the *coordinator*.

## Set up Houston

1. Open any chat. Its Agent and engine can be anything you use: Claude Code,
   Codex, an ACP agent or Station's own engine.
2. Open the chat's **More** menu (the **⋯** sheet on a phone) and choose
   **Make this Houston**.

Home (Mission Control) now shows a **Houston** card with **Talk to Houston**,
which opens that chat. You have one Houston. If another chat already is,
the menu offers **Make this Houston instead**, which replaces it. **Stop using
as Houston** removes it.

Houston gets Station's own tools (Station Control) whatever Agent it runs, so
it can delegate work to other engines, read Sessions and Tasks, and message
you. An ACP agent receives them only if it supports HTTP MCP servers;
otherwise the chat works without them and Station records that they were not
delivered. They arrive with Houston's next Session: a chat that was already
running when you chose it picks them up when it next starts a Session. It acts with
your normal permissions and approval mode, and asks you for approvals as any
chat does. Anything your Agent configures, including its own auto-approvals,
still applies.

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

The same item is never sent twice. Houston's own turns don't wake it. Work it delegated
itself doesn't wake it when it finishes or fails, because that result already
comes back to it directly; if that work needs you, Houston is told. A message waits for Houston's current turn to finish;
it never interrupts it.

## Limits

- Requested stops, pairing requests and scheduler notices don't wake Houston.
  Only work that names a Session does.
- A hosted Station has no Houston.
- Houston doesn't keep a separate record of your Projects yet. It works from
  its own conversation and what it reads from Station.

See the [glossary](../glossary.md) entry *Coordinator Session* and the
[decision record](../decisions/personal-coordinator-session.md).
