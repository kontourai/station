# Station Concepts

Station uses a small set of user-facing concepts. Transport names, process
details, and internal record shapes stay out of the way unless setup or
diagnosis requires them.

## Station And Device

- A **Station** is the host you connect to and work on.
- A **device** is what you connect from: a browser, phone, tablet, or laptop.
- Pairing grants a device scoped, revocable access to a Station.

## Agents, Engines, Providers, And Models

- An **agent** is the working identity you choose for a Task or Session.
- A **Station agent** is executed by Station's engine. Station owns its prompt,
  skills, tools, commands, and Model choice.
- An **External agent** is executed by another supported engine. That engine
  owns its behavior and tool loop.
- A **Provider** is the user-facing connection to a model service or agent app.
- A **Model** is the inference option selected within a Provider.

Station names the concrete engine when that distinction matters. Protocols such
as ACP are connection details, not agent types users need to choose.

Concrete examples:

- **Local model:** a local model service is the Provider, one of its installed
  models is the Model, and a Station agent uses Station's engine to run it.
- **External engine:** the engine is the Provider; the Agent is an External
  agent because that engine owns its tool loop.
- **Hosted model:** a hosted model service is the Provider, one of its models is
  the Model, and a Station agent owns the prompt, skills, and tools around it.

See the [Connections guide](https://github.com/kontourai/station/blob/main/docs/guides/connections.md)
for the current supported Providers and their setup details.

## Projects, Tasks, And Sessions

- A **Project** supplies the working context and available agents.
- A **Task** is durable work that can be reopened with its workspace binding,
  files, artifacts, receipts, and exact execution correlation.
- A **Session** is one bounded execution episode. A Task can have more than one
  Session over time.
- A **direct chat** is an immediate conversation and does not silently create a
  Task.

Example: “Explain this function” can be a direct chat. “Refactor this module,
run its gates, and preserve the evidence” should be a Task. Each attempt or
continuation is a Session attached to that Task.

## Gates, Evidence, And Receipts

- A **gate** decides whether work may advance.
- **Evidence** supports a claim made by the work.
- A **route-back** sends failed or incomplete work to a named earlier step.
- **Readiness** explains whether repository or project requirements are met.
- A **receipt** records what ran, what passed or failed, and what remains
  unverified.

Station keeps these beside the work so a confident answer is not mistaken for
a verified outcome.

Example: a test result is evidence. The rule requiring that test is a gate. The
record saying which command ran and whether it passed is the receipt. If the
test fails, a route-back sends the work to the step that can fix it.

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

Station stores its data under `~/.station` by default. A Provider receives data
only when you configure it and use a feature that needs it. Observability data
leaves the machine only when an operator configures an export endpoint.

## Next

- Follow [Getting started](getting-started.md).
- Customize [keyboard shortcuts](../guides/keyboard-shortcuts.md).
- Review the [Station privacy policy](https://kontourai.io/privacy/station/).
