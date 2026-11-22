---
status: current
subject: Station's first-release screens follow one agreed structure and one user vocabulary
decided: 2026-11-21
evidence:
  - kind: doc
    ref: docs/design/first-release.md
  - kind: doc
    ref: docs/plans/first-release-ui.md
  - kind: issue
    ref: https://github.com/kontourai/station/issues/5386
---

# First-release UI

The owner agreed on 2026-11-21 the structure and vocabulary in the
[first-release design](../design/first-release.md). Its ten area files list
every screen and its numbered changes; the
[execution plan](../plans/first-release-ui.md) orders the slices, and
[#5386](https://github.com/kontourai/station/issues/5386) tracks them.

## What was decided

- **Getting around.** A quiet sidebar (New chat, Home, Automations, Projects,
  Apps, then Customize and Settings). Customize is a page with its own address
  and six items in three groups, with an attention dot; any item can be pinned
  to the sidebar. Connections stops being a destination: its parts become
  Customize items, and devices, people and other Stations move to one Station
  page opened from the header's Station chip. First run is Home itself; the
  setup wizard, tour and "Finish setup" card go.
- **What agents run on.** Engine → Provider → Account → Model. The thing a
  person picks and meters is provider plus account. Engines show only what
  Station knows: signed in; installed, sign-in not checked; needs sign-in; not
  installed.
- **Projects.** New Project asks one question (start empty, use a folder, or
  clone from Git). A project is one page with Overview, Chats, Tasks, Files
  and any app added as a view. A task has one status.
- **Chat.** One Details panel with Setup, Usage and Work tabs replaces the
  stats modal, the inventory pane, the Basis pane and the chat settings
  dialog. After an engine change, usage is shown per engine and never summed.
- **Apps.** An app is something a person adds that has its own screen. Apps
  live in the sidebar with Discover, Library and Updates; boards are one
  built-in kind. "Plugin" stays as the packaging and developer word.
- **Inbox, automations and settings.** Mark done replaces Settle, Dismiss and
  Hide. Automations show the next seven days, recent runs and a labelled
  Pause. Settings is a grouped, searchable list.

The vocabulary and the full list of words that change are in the design
record's [Vocabulary](../design/first-release.md#vocabulary) and
[Words that change](../design/first-release.md#words-that-change) sections.

The open questions were settled as recommended:

- Apps from sources other than Station are not in the first release, and an
  app's sidebar place is per person.
- Per-run limits for scheduled automations, turn ranges in chat usage, and
  setup-from-chat screens come later.
- "A new task in a project" ships as an automation result only if such a
  schedule can be edited and deleted from Automations; otherwise the first
  release offers "Its own chat" only.
- Each area lands complete without a flag, except the sidebar change, which
  sits behind one preview until its phase is whole.

## Records this changes

These records stay true on `main` until the code changes. The slice that lands
each change amends its record in the same pull request:

- [Glossary](../glossary.md): "Provider" becomes a user-facing noun again and
  "Model connection" retires (Customize provider slices, 2.11 to 2.15); the
  Connections, device pairing, Plugin and Integration, placement (Layout,
  Workspace view), settlement, Notifications and Inbox, chat inventory and
  Basis, and Profile entries change with the slice that changes each word.
- [Shell ownership and boards](../design/shell-ownership-and-boards.md): rows
  above Projects and pinned Customize items reverse the rejected "global views
  band" alternative and the footer placement (slices 1.5 and 1.6); removing
  the Review layout and `#general` from the sidebar revisits D4 (slice 3.3).
- [Module map](../architecture/module-map.md): the DestinationRegistry rule
  that a Customize row cannot also be a sidebar entry (slice 1.6).
- [Connections overhaul](../design/connections-overhaul.md) is superseded,
  and the finite readiness labels in
  [Connections onboarding](../design/connections-onboarding.md) change (slice
  1.2 and the Customize slices).
- [Telemetry tiers](telemetry-tiers.md), "Usage sharing presentation": the
  first-run dialog becomes a dismissible card that keeps the shown-notice and
  explicit-action rules (slice 1.8).
- [Settings architecture](../design/settings-architecture.md) section 4.1:
  one save behaviour across Settings and project settings replaces batched
  Save and Discard (slices 5.17 and 3.10).
- [Custom appearance](custom-appearance.md): the Appearance page moves into
  Settings, and the agent guide's "/appearance" changes with it (slice 5.19).
