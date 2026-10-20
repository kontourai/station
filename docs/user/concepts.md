# Station Concepts

Station uses a small set of user-facing concepts. Transport names, process
details, and internal record shapes stay out of the way unless setup or
diagnosis requires them.

## Start with a computer, AI, and a conversation

Your computer runs Station and your AI apps. Choose an AI and send a message.
A phone connects to that computer to use the same conversations and files.

Add a **Project** when you want to work in a folder or share context. Save a
custom **Agent** when you want reusable instructions and tools. Choose **Run a
task…** when you want tracked work you can return to. These choices can wait
until you need them; starting a chat does not require creating each one.

## Station And Device

- A **Station** is the host you connect to and work on.
- A **device** is what you connect from: a browser, phone, tablet, or laptop.
- Pairing grants a device scoped, revocable access to a Station.

## Agents, Engines, And Model Connections

- An **agent** is the working identity you choose for a Task or Session.
- A **Station agent** is executed by Station's engine. Station owns its prompt,
  skills, tools, commands, and Model choice.
- An **External agent** is executed by another supported engine. That engine
  owns its behavior and tool loop.
- A **Model connection** is a local or hosted model service that Station's
  engine runs inference on. Connections lists these on its **Models** tab.
- An **Engine** is an installed agent CLI, or a custom engine you connected,
  that runs its own agent loop. Connections lists these on its **Engines** tab.
- A **Model** is the inference option selected within a Model connection or
  offered by an Engine.

Station names the concrete engine when that distinction matters. Protocols such
as ACP are connection details, not agent types users need to choose.

The reserved Agent named **Station** is a separate role. Its name does not tell
you which engine runs it; that engine is selected in Station settings.

Concrete examples:

- **Local model:** a local model service is the Model connection, one of its
  installed models is the Model, and a Station agent uses Station's engine to
  run it.
- **External engine:** the engine is the Engine connection; the Agent is an
  External agent because that engine owns its tool loop.
- **Hosted model:** a hosted model service is the Model connection, one of its
  models is the Model, and a Station agent owns the prompt, skills, and tools
  around it.

See the [Connections guide](https://github.com/kontourai/station/blob/main/docs/guides/connections.md)
for the current supported model services and engines and their setup details.

## Projects, Tasks, And Sessions

- A **Project** supplies the working context and available agents.
- A **Task** is durable work that can be reopened with its workspace binding,
  files, artifacts, receipts, and exact execution correlation.
- A **Session** is one bounded execution episode. A Task can have more than one
  Session over time.
- A **turn** is one unit of input and execution within a Session. Continuing a
  conversation can add a turn to its existing Session; it does not necessarily
  create a new one.
- A **direct chat** is an immediate conversation and does not silently create a
  Task.

Example: “Explain this function” can be a direct chat. “Refactor this module,
run its gates, and preserve the evidence” should be a Task. A Task can retain
one Session across several turns and use another for a later attempt.

When a conversation status/history read or an inbox read fails, retained
conversation rows say **Last known:** before their computed status. The status
uses a muted style without a pulsing indicator or running clock. The transcript's
background-work indicator also says **Last known**. Each reader keeps its own failure until that reader succeeds; loading older
history does not clear a failed current-history read. A live update past the
failed observation’s sequence within the same stream epoch supersedes that failure individually: it verifies
current status, even if the older read fails after that update. The sequence is
captured when the read starts. A stream epoch change (such as replacing the
orchestration database) resets sequence fences and retires pending old-epoch
reads. Unrecovered failures stay last known until a new-epoch observation arrives. The history pane keeps any history-read error until its
reader recovers. Hiding and
showing a row preserves its last-known status. Observations are released when
the conversation is absent from the loaded inventory and no row or reader
references it, or its authority query cache is cleared. A released reader cannot
recreate an observation when its pending read settles. Other conversations and
Stations retain their own observations. Use **Resync** on the
conversation or **Refresh inbox** to request fresh observations.

**Messages held by Station** lists follow-ups already stored in the open
conversation's server inbox, including those submitted from another client.
Its pending count covers waiting and sending messages. A failed read says
unavailable; it does not mean the queue is empty. **Refresh** reads it again.
**Remove** withdraws a waiting message when your identity is allowed to do so;
a message already being sent cannot be removed. An unknown delivery outcome
stays visible without being counted as pending. This list is separate from
browser-local queued drafts; the composer's ordinary Queue action still uses
those local drafts.

## Gates, Evidence, And Receipts

- A **gate** decides whether work may advance.
- **Evidence** supports a claim made by the work.
- A **route-back** sends failed or incomplete work to a named earlier step.
- **Readiness** explains whether repository or project requirements are met.
- A **receipt** records what ran, what passed or failed, and what remains
  unverified.

Station can keep these beside the work through its workflow and evidence
integrations. Task status, a completed agent run, and a passed gate are separate
facts; inspect the recorded evidence rather than inferring one from another.

Example: a test result is evidence. The rule requiring that test is a gate. The
record saying which command ran and whether it passed is the receipt. A
workflow can use a route-back to send a failed test result to the step that
can fix it.

- A **degraded capability** is a bounded feature Station runs without,
  reported with a specific reason and remediation instead of failing silently
  or refusing to start.

Example: interactive terminal panes need the `node-pty` native module, which
requires a C++ compiler to build on Linux. On a machine without one, Station
installs and runs with the terminal capability degraded: `station doctor`
prints a warn line with the rebuild command, the system status readiness
record reports `terminal` as not ready with the same reason, and opening a
terminal pane states why it cannot open. Agent execution does not use
`node-pty` and is unaffected.

## Local-First Data

Station stores its data under `~/.station` by default. Model services, Engines,
paired devices, remote computers and other configured integrations can exchange
data outside that directory. Some make startup or background requests; desktop
builds also contact their release feed. Observability export requires a configured
endpoint. See the repository's [data-flow working copy](https://github.com/kontourai/station/blob/main/docs/privacy-policy.md) for the
distinction between declared settings and verified behavior.

## Next

- Follow [Getting started](getting-started.md).
- Customize [keyboard shortcuts](../guides/keyboard-shortcuts.md).
- Review the [Station privacy policy](https://kontourai.io/privacy/station/).
