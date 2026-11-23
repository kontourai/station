# Automations

An automation is work Station runs for you on a schedule: every weekday at
9:00, every hour, or once at a set time. Open **Automations** in the sidebar
(it was called Schedule; old `/schedule` links still work).

## The list

**Next 7 days** shows what runs from now to the end of the sixth day after
today, in your time zone. A day lists its first three runs, then how many
more. Paused automations are left out. On a phone it is **Next up**: the next
three runs.

Below it, **All automations** has one row per automation: its name, the agent
and where results go, the schedule as a sentence ("Weekdays at 8:00 AM", with
the zone named when it is not yours), the next run, and a strip of its last 12
runs. A filled square worked, a red square with a dot failed, an outline was
skipped because it was too late, and a dashed outline means Station cannot
tell how it ended. The status reads **Active**, **Paused** or **Running**, or
**Done** for a one-time automation that has had its run (it lists last, says
when it ran, and has no Pause or Resume; **Run now** still runs it again). A
row can carry a flag: **Last 2 runs didn't work**, or **Paused itself after 5
runs that didn't work** when Station turned it off. "Didn't work" covers runs
that failed and runs whose outcome Station cannot tell. Open **⋯** on a row
for **Run now**, **Pause** or **Resume**, **Edit**, **Duplicate** and
**Delete**; if one of them fails, the page says so. Select the name to see its
instructions and run history, or select a run in **Next 7 days** to go to its
automation.

A filter appears once you have more than 15 automations. If the scheduler is
stopped, or has stopped checking for due runs on time, the page says so above
the list; otherwise it says nothing about the scheduler.

A job whose stored record needs repair appears separately for the Station
operator, with a job ID for recovery. Healthy automations remain available.

## Name and one-time runs

Give an automation a name in plain words, such as "Daily briefing". You can
rename it later in **Edit**; its runs and history stay with it.

**One time** runs an automation once, at 9:00 AM tomorrow unless you pick
another time. **Remove it after it runs** starts unticked, so the automation
stays in the list with its run.

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

## Project schedules

A schedule can belong to a Project. It is a Feature Preview: turn on
**Project schedules** in Settings → Advanced → Feature previews. Create one
from Project settings →
**Schedules** → **New schedule**, or approve one an agent proposed in a chat
(`propose_job` with the Project's id). Each run starts a new **Task** in that
Project for the Agent you pick, on that Agent's engine. The Task's first
message is the schedule's instructions, so the Session starts with the Task
brief like any Task. The Task belongs to whoever created the schedule and
acts for them, with their role in the Project. When the run ends, Station
writes a one-line run summary as the Task's summary; the answer itself is in
the Task's chat.

Creating a schedule, including approving an agent's proposal, requires permission
to start work in the Project. People who can view the Project can see its
schedules and their recorded runs. Older run records without a recorded
destination still require owner access. The Station operator can see Project
schedules and their current-format run history through the operator sign-in.
Editing, enabling or manually running a schedule requires its creator to
still have permission to start work in the Project, including when the Station
operator acts on their behalf. The creator or the Station operator can still
disable or delete the schedule after the creator loses that permission.

While the Project is paused or archived its schedules wait: Station does not
start a run, and **Run now** is refused. After **Resume**, a schedule that
came due while paused runs once, unless it is more than six hours late, in
which case that occurrence is recorded missed. Deleting the Project deletes
its schedules. A schedule's Project is set when it is created and cannot
change. Turning the preview off holds every Project schedule the same way.

## What a chat shows

A chat's **Automations** section lists everything that will act on it
later:

- automations that run in the chat,
- check-backs the agent scheduled (`schedule_wake_up`): one follow-up at most
  a day ahead, at most 3 waiting and 20 per hour per chat,
- automations the agent proposed (`propose_job`), waiting for your approval,
- GitHub Automation sources and rules the agent proposed
  (`propose_automation_source`, `propose_automation_rule`), waiting for you
  to confirm.

An approved proposal runs in the chat that proposed it.

A GitHub source or rule proposal is a card that says, in Station's words,
what it watches, what it opens, which agent it wakes, and with what limits.
What the agent wrote (its name for it, its conditions, its reason, and the
complete instructions a rule gives) is shown apart, under **Written by the
agent**. Open **Instructions the agent will be given** to read them in full.
If the chat had read content written by others, such as email, before the
agent proposed this or at any time since, the card says so first.
Confirming checks again that the agent's chat could still start that work,
and refuses if an Agent it names has moved, changed or been removed. **Confirm** creates it, and only the Station operator can confirm.
A confirmed source starts disabled and a confirmed rule starts observing: it
records what it would do but starts nothing. Tick **Turn it on now** to
enable the source, or set the rule live, in the same step. **Decline**
creates nothing. Proposals are meant to come only from a message you typed
into Station's chat. Work that an automation, another agent's result, the
CLI or another Station started is refused. Station works out which message
the agent is answering from the chat's state, and a known timing race
(a steer sent while another agent's result is starting) can let an agent's
continuation create a card. Nothing is created unless you confirm it, so
read each card before confirming. The fix is tracked in
[#4882](https://github.com/kontourai/station/issues/4882).

## Failures, missed runs and turning off

- A run that fails is listed as failed and notifies you. The notice is generic;
  open Automations to see the jobs and runs you can access.
- After **5 runs in a row that didn't work** (failed, or ended with an
  outcome Station cannot tell), Station pauses the automation and notifies you
  once. Its row reads **Paused** with the flag **Paused itself after 5 runs
  that didn't work** until you resume it. A run that retried counts once.
  A successful run resets the count, and so does resuming the automation.
- If Station was not running when a chat automation was due and it is more
  than **6 hours** late, that run is recorded as missed instead of running
  late.
- Station never repeats a run that may already have reached the engine. If a
  run's outcome is unknown (Station restarted, or the turn ran longer than
  30 minutes), the run says so; open the chat to see what happened.

## Templates

With no automations yet, the page says what one is and offers four
templates, each with what it does and when: **Daily repo digest**, **Check
back on open work**, **Weekly dependency check** and **Stale pull requests**.
Templates only ask for work an agent can do with its workspace and tools. You
can also ask in any chat ("Every morning, tell me which tests failed
overnight"): the agent proposes an automation for you to approve.

## Limits

- An automation that runs in a chat cannot retry and cannot have a GitHub
  pull request monitor.
- An agent can create, change, run or delete an automation only in its own
  chat. A dedicated chat is your choice. To change or run an automation that
  runs in a chat, you must be able to send to that chat.
- An automation acts as the person who created it; editing it does not change
  that. Its Station tools act for that person too. A Project schedule's run is
  a Task that belongs to the person who created the schedule and acts for
  them, with their role in the Project: if they can no longer start work in
  that Project, the run doesn't start. A Project schedule with no recorded
  owner doesn't start a Task at all.
- Only an automation's owner, or an agent acting for them, can change, run,
  turn on or off, or delete it. You, signed in as the Station's operator on
  this computer or with the operator credential, can also manage any
  automation that doesn't run in a chat; when you run it, it still runs as its
  owner. Project schedule history follows the rules above. You can't
  point someone else's automation at a chat; only its owner can.
- On a personal Station, older automations created before Station recorded an
  owner became yours once, when you updated. An automation without an owner
  shows that it needs one, and its runs have no Station tools until someone
  re-creates it.
- Start notifications are not sent; the old `notifyStart` setting is ignored.
- GitHub event triggers are not part of Automations yet
  ([#3439](https://github.com/kontourai/station/issues/3439)).

See [the decision record](https://github.com/kontourai/station/blob/main/docs/decisions/automations-unify-schedules.md) for
the rules behind this behaviour.
