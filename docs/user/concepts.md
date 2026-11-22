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

## Choose a Project, Task, or direct chat

Start a **Project** when several conversations need the same files,
instructions or tools. Add a **Task** when a particular outcome needs a plan,
work chats or evidence you can reopen. A **direct chat** is enough for a
standalone request you can finish in one conversation.

| Use a Project when you want to… | What stays together |
| --- | --- |
| Hold p95 API latency under 200 ms through the next release | The API repository, benchmark instructions and separate investigations |
| Retire the v1 endpoint across API, web and mobile | Migration instructions, the repositories or folders you connect, and a Task for each rollout |
| Maintain onboarding docs for three services | Source documents, terminology and repeatable review instructions |
| Review weekly changes to a shared release checklist | The checklist, Project context and recurring review Tasks |

| Start somewhere else when you want to… | Use |
| --- | --- |
| Find out what an error means before deciding whether to investigate | A direct chat |
| Ask an Agent to suggest three names for a command | A direct chat |
| Ship one migration in a Project you already have | A Task in that Project |
| Review a pull request in the same context as a tracked bug | The existing Task and its work chats |

### Example Project brief

Enable **Project brief, memory and models** in **Settings → Advanced →
Feature previews**, then open **Brief** in Project settings. Put one line in
**Goal** and the fuller instructions in **Instructions**. Save the brief for
new Sessions in the Project.

**Goal**

Keep p95 API latency under 200 ms through the next release.

**Instructions**

- **What this Project is for**
  Investigate latency spikes and keep benchmark results with each change.
- **Where work happens**
  Use the API repository, start from `main`, and prefix pull request titles
  with `perf(api)`.
- **How to check your work**
  Run the existing latency benchmark against the same recorded workload.
  Include the command, workload and before/after p95 results in the Task.
- **When something is missing**
  Say which environment or benchmark data you need and stop until it is
  available.
- **What needs my go-ahead**
  Ask before changing the benchmark workload, running a production load test
  or merging a pull request.

### Troubleshoot Projects and Tasks

Some messages include details from the Station. Start with the action shown
next to the message. When a button name starts with **Retry**, use the one
in the panel that reported the error.

#### Open a Project or Task

| Message | Next step |
| --- | --- |
| **Could not load Projects** | In the board's Projects section, select **Retry Projects**. |
| **Station connection unavailable** | In **Connections → Computers**, connect to a Station with access to the Project. |
| **Could not load project** | Select **Retry** on the Project page. |
| **Project is taking longer than expected** | Select **Retry** to reload the Project. |
| **Could not load Tasks** | Select **Retry Tasks** in the Project overview. |
| **Unable to verify Task project** | Select **Retry** to check the Project again. |
| **Unable to load task** | Select **Retry** in the Task workspace. |
| **Task not found** | Open the Task from its Project's Tasks list to confirm it is still available to you. |
| **Project deleted** | Use the Task's existing chats and details to recover context for new work. |
| **Task workspace is unavailable** | Open the Project and check its working folder before starting new work. |


#### Project tools, files and rooms

| Message | Next step |
| --- | --- |
| **Search unavailable**, **Channels unavailable**, **Room unavailable. Check your connection and Project access.**, **This thread could not be loaded.**, **History could not be loaded.** | Select **Retry** in the search, channel, room or history panel. |
| **Could not load layouts**, **Couldn't load the Library**, **Couldn't open this file** | Select **Retry** in the affected panel. |
| **Couldn't load project knowledge**, **Couldn't load project rules**, **Could not load stores**, **Could not load records** | Select **Retry** in the affected knowledge panel. |
| **Could not load document categories** | Select **Retry categories**. |
| **Could not load indexing status** | Select **Retry indexing status**. |
| **Could not load documents** | Select **Retry** in Project knowledge. |
| **Migration failed** | Check the reported error and the current knowledge store before retrying migration. |
| **Knowledge action failed** | Check the reported directory or named files, then retry the index or upload action that failed. |
| **Could not remove document** or **Could not remove documents** | Reopen Project knowledge and check which documents are still listed before confirming another removal. |
| **Couldn't index the working directory** | Read the reason shown, correct it, then choose **Index Files** again. |
| **Unable to load document content** | Close the knowledge document and reopen it from the Project. |
| **Unable to check Task sharing** | Select **Retry** in Task sharing. |
| **Tool access unavailable** | Select **Retry tool access**. |
| **Project tools unavailable** | Select **Retry Project tools**. |
| **Agent request storage unavailable.** | Reopen the Room in a fresh tab with browser storage allowed. Check the Room for any earlier Agent request before sending again. |
| **Agent start could not be confirmed. Check its answer before retrying.** | Check for the Agent’s answer in the Room before using the saved request’s retry. |

#### Task work and results

| Message | Next step |
| --- | --- |
| **Unable to load tasks**, **Couldn’t read agent runs.**, **Couldn’t refresh pull requests** | Select **Retry** in the Project's Tasks list or board. |
| **Subtasks unavailable.**, **Work chats unavailable.**, **Unable to load kept answers**, **Couldn’t read the Task memory**, **Could not load the pull request watch** | Select **Retry** in the Task panel that reported the error. |
| **Task room document is unavailable.** | Reopen the Task on its owning Station to check Room access. |
| **Chat selection unavailable.** | Select **Retry selection** to reload the recent chat choices. |
| **Chat link unavailable. Select a chat and try again.** | Select a chat again before retrying the link. |
| **Couldn’t load Task outputs:** | Select **Retry outputs**. |
| **Some results could not be loaded.** | Select **Retry results** in **Ready to review**. |
| **Couldn’t refresh Timeline.** | Select **Retry Timeline**. |
| **Some Screens are unavailable.** | Select **Retry unavailable Screens**. |
| **Couldn’t refresh Review.** | Select **Retry Review**. |
| **Code review unavailable** | Select **Reload review data** to check the review. If the panel says access changed, reopen the Task first. |
| **Request recovery could not be saved** | Allow browser storage, then select **Check status** to read the review state before requesting a review again. |
| **Request outcome unknown** | Select **Check request** to check whether Station received that review request. |
| **Couldn’t load this Screen.** | Select **Retry Screen** in the Screen detail. |
| **Couldn’t load this item.** | Select **Retry item**. |
| **Couldn’t load clips.** or **Couldn’t load this clip.** | Select **Retry clips** for the list or **Retry clip** for the open clip. |
| **This Screen is unavailable. Capture it again.** | Make another capture from the Project's Browser or Device session. |
| **This item is unavailable. Refresh and try again.** | Refresh the Review panel before retrying the action. |

#### Sharing and changes to work

| Message | Next step |
| --- | --- |
| **Shared work is unavailable** | Select **Retry** in **Shared work**. If your access changed, ask the Project owner what is still shared with you. |
| **Publication is unavailable for this account.** | Choose **Refresh publication status** to check the shared Task with the current account. |
| **Shared document is unavailable.** | Check **Refresh publication status** first. If the Task is still published, reopen it to check the document. There is no separate retry on this document message. |
| **Could not change watching** | Read the error, check the current watching mode, then choose the intended action again if it is still needed. |
| **Write-back history unavailable** | Check the Task connection, then select **Retry** under **Written to the issue**. This reloads the history. |
| **Could not create store** | Read the error and inspect the Project's store list before choosing **Create store** again. |
| **Couldn't save project rules** | Check the error and your draft, then choose **Save Rules** if the change is still needed. |
| **Couldn’t keep “TITLE” as an output:** or **Couldn’t delete “TITLE”:** | Reopen the Task's outputs and check whether the file is present before attempting the change again. The message includes the actual title. |
| **Output content is unavailable:** | Check the error and reopen the output. Keep the existing output while checking access and content availability. |
| **Feedback could not be confirmed. Retry the same statement.** | Use **Retry same statement** to resend the same review text. |
| **Couldn’t load capture sessions.** or **Some capture sessions could not be loaded.** | Select **Refresh sessions** in the capture dialog. |
| **Still couldn’t link it. Your task is safe; try again later and it won’t create a second task.** | Use **Link it now** later on that Task. |

For more on recovery and access boundaries, see
[sharing setup](https://github.com/kontourai/station/blob/main/docs/guides/deployment-authentication.md),
[Project knowledge](https://github.com/kontourai/station/blob/main/docs/guides/knowledge.md),
and [Task-owned pull requests](https://github.com/kontourai/station/blob/main/docs/decisions/task-owned-pull-requests.md).

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

A Project's **Tasks board** files each Task by what is true of it now, never
by a stored status: **Needs you** (its run asks for an approval or answer, the
Task has an open question, the run failed, its pull requests merged and the
Task can be marked done, a watched pull request used every fix attempt, or
someone marked it blocked or for review),
**Running**, **In review** (an open pull request with changes requested,
conflicts, checks not passing, a draft, a pending review, or an unknown
state),
**Ready to merge** (every open pull request clean at its provider) and
**Idle**. Backlog, Done and Canceled are shelves below. A fact Station could
not read claims nothing: a run it cannot see reads *Run status unavailable*
and keeps the Task out of Ready to merge, and so does a pull request it could
not read. A Task someone marked blocked stays in Needs you whatever its pull
requests say.
Each card shows one status line and one next action. The Project page's
Tasks section switches between this board and a list.

A Task can **watch the pull requests** kept on it, when its Project's
**Pull requests** setting is on or the Task's own **Watch pull requests** is
(behind the Pull request agent feedback Feature Preview). Station then wakes
the Task's agent when CI fails or a reviewer writes, never on a timer of the
agent's own, and each failure or comment wakes it once. The Task's **Pull
request watch** panel shows each pull request as Watching, Fixing, or **Ready
for you** once checks pass and reviews are answered. After the Project's
number of fix attempts (3 unless changed) the Task moves to Needs you as **Fix
attempts used**, with the failing checks named, and Station notifies you once. Merging stays with you: the
agent's attempts to merge, arm auto-merge or force-push are refused, a change
to CI configuration asks you first, and each is listed under **Refused
actions**. **Stop watching** turns it off for that Task. See
[Task-owned pull requests](https://github.com/kontourai/station/blob/main/docs/decisions/task-owned-pull-requests.md) for what
this does and does not cover.

### Library

Turn on **Project Library** in Settings → Advanced → Feature previews.

A Project's **Library**, on its **Files & connections** tab, lists the files
people add and the files its Tasks keep, newest first. Filter it by **Added by
people**, **Kept by Tasks**, or one Task; **Preview** opens text and PNG files
inline and offers **Download** for the rest.

- **Add files** or **Add folder** uploads into the Project. A folder keeps its
  layout; hidden files (such as `.git` or `.env`) and installed-package folders are
  skipped, and each file can be up to 25 MB.
- Every chat in the Project can read the Library, whatever its engine: agents
  list it with `list_project_library` and read a file with
  `read_project_library_file`. A chat started before its Project was recorded
  is refused; start a new chat in the Project.
- A kept Task output stays where its Task keeps it. The Library shows it with a
  link to its Task, and as **Orphaned** once that Task is deleted. It is still
  listed and readable.
- The Library is on personal Stations. A hosted Station does not offer it.

A Project schedule runs each run as a Task in the Project, so a file that run
keeps appears in the Library with a link to its Task.

### Save to Project and Setup recommendations

Turn on **Save to Project** in Settings → Advanced → Feature previews.

When a chat produces a next step you want to keep, open its More menu and
choose **Save to Project…**. A personal chat lets you pick a destination.
For an answer that already belongs to a Project, Station selects that Project.

- Choose a Project, edit the Task title and brief, then select **Create
  Task**. If the chat has a completed answer, the Task links back to it.
  If the Task was created and the link failed, **Link chat to Task** finishes
  that step on the same Task.
- Choose **New Project…**, then **Review new Project** to edit the name,
  folder and brief before creating it. That Project can then offer the chat
  as a starter Task.

A new Project with no Tasks shows **Setup recommendations**: a brief draft
when it has none, a read-only **Explore and propose next steps** Task when a
repository is attached, and a Task that cites the chat it was continued from.
Each is on until you turn it off. Nothing is created until **Apply**; **Not
now** hides the card for that Project.

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
conversation, or **Retry** when the inbox says it could not refresh, to request
fresh observations.

The pending-message list above the composer also shows follow-ups Station
holds in the open conversation's server inbox, marked **Held by Station**,
including those submitted from another client. Its count covers every message
it lists, including one whose delivery outcome is unknown, and the chat's
context card shows the same count. If the list can't be read after showing held messages,
it says so and offers **Retry**; that does not mean nothing is held.
**Remove** withdraws a waiting held message when your identity is allowed to do
so; a message already being sent cannot be removed. The composer's Queue action
requests inbox admission for an eligible busy conversation; Station can hold the
follow-up or return a started-turn receipt. Other clients see the same server
queue. Older saved input without a Station identity remains for destination
review and does not send automatically.

A restart can preserve a conversation while marking its unfinished turn as
interrupted. This does not mean the Agent resumed. If a send lost its reply,
the browser checks its original message key before retrying. A queued answer
keeps those checks running; a started answer confirms delivery and removes the
retry notice. After three consecutive failed delivery reads, automatic checks
pause. The message stays saved and reads **May have reached the agent**. Its
chat keeps the status its turn gives it, and the inbox row adds **Last message
may not have arrived** with **Check**. **Check** asks once and shows the result; it
does not resend. If Station confirms it never received the message, **Retry**
sends it using the same key. **More delivery actions → Copy message** preserves its text for recovery.
Uncertain delivery remains fenced to prevent duplicate work.

Native steering has engine-defined placement. Station-owned steering waits for
an observed tool boundary in that turn. The pending row shows a refusal if the
turn ends before the steer is placed. If a handoff may have reached an engine,
**May have been sent** stays visible. **Review and resend**
restores the text into an empty composer; sending again is your explicit choice.
Display-only notes appear immediately without sending anything to an engine.

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
