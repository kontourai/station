# Automations

An automation is work Station runs for you on a schedule: every weekday at
9:00, every hour, or once at a set time. Open **Automations** in the sidebar
(it was called Schedule; old `/schedule` links still work).

## Where an automation runs

Choose **Run in** when you create one:

- **Its own chat** (the default). The first run starts a conversation with
  the Agent you pick, on that Agent's engine: Station's own, Claude Code,
  Codex, or another connected engine. Every later run continues that chat.
- **This chat.** Offered when you start an automation from a chat (**New
  automation** in the chat's Automations section). Each run is a new message
  in that chat, on whatever engine it already uses.
- **Station engine, output file.** The older behaviour, kept for existing
  jobs and for Stations that do not support running in a chat. It runs on
  Station's own engine only and saves the output to a file.

Each run in a chat is a message from Station, not from you. It says which
automation is running and when its last successful run was, so recurring
work can cover only what changed since. The run uses the chat's normal
approval mode: if the agent needs your approval, the chat shows it under
needs-you, and the run waits for you.

The engines offered depend on your Station. A Station that does not advertise
chat automations offers only the output-file run, which cannot use an external
engine.

## What a chat shows

A chat's **Automations** section lists everything that will act on it
later:

- automations that run in the chat,
- check-backs the agent scheduled (`schedule_wake_up`): one follow-up at most
  a day ahead, at most 3 waiting and 20 per hour per chat,
- automations the agent proposed (`propose_job`), waiting for your approval.

An approved proposal runs in the chat that proposed it.

## Failures, missed runs and turning off

- A run that fails is listed as failed and notifies you. The notice is generic;
  open Automations to see the jobs and runs you can access.
- After **5 failed runs in a row**, Station turns the automation off and
  notifies you once. A run that retried counts once. A successful run resets
  the count, and so does turning the automation back on.
- If Station was not running when a chat automation was due and it is more
  than **6 hours** late, that run is recorded as missed instead of running
  late.
- Station never repeats a run that may already have reached the engine. If a
  run's outcome is unknown (Station restarted, or the turn ran longer than
  30 minutes), the run says so; open the chat to see what happened.

## Templates

New automations can start from a template: **Daily repo digest**, **Check
back on open work**, **Weekly dependency check** and **Stale pull requests**.
Templates only ask for work an agent can do with its workspace and tools.

## Limits

- An automation that runs in a chat cannot retry and cannot have a GitHub
  pull request monitor.
- An agent can create, change, run or delete an automation only in its own
  chat. A dedicated chat is your choice. To change or run an automation that
  runs in a chat, you must be able to send to that chat.
- An automation that runs in a chat acts as the person who created it; editing
  it does not change that.
- Start notifications are not sent; the old `notifyStart` setting is ignored.
- GitHub event triggers are not part of Automations yet
  ([#3439](https://github.com/kontourai/station/issues/3439)).

See [the decision record](https://github.com/kontourai/station/blob/main/docs/decisions/automations-unify-schedules.md) for
the rules behind this behaviour.
