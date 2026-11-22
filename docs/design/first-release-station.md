# First-release design: Station: devices, people and other Stations

Status: agreed design; delivery in progress under [#5386](https://github.com/kontourai/station/issues/5386). GitHub owns live delivery state.

Part of the [first-release design](first-release.md). The numbered changes on each screen are the acceptance criteria for the slices that deliver them. Slice numbers refer to [the execution plan](../plans/first-release-ui.md).

One Station page, opened from the header chip, holds devices with access, people and other Stations.

## What is wrong today

- Device and Station tasks are spread over six places: the header chip menu, the connection manager dialog, Connections › Computers, Settings › Devices, Settings › Advanced › Device hosts, and the unpaired screen.
- The header chip menu mixes switching Stations with Forget, "Forget N unreachable", Details, Pair phone and Manage.
- The manager is a stack of small dialog panels: Stations, Add Station, Request Access, Scan a pairing code, Enter a pairing code, Pair a Device, Paired Devices and Nearby Stations. Paired devices are shown only inside it.
- Connections › Computers mixes devices, peer Stations, SSH computers and broker routes under one noun.

## Agreed structure

- The header chip is the single entry point: a dot, the Station name and a state word. On phones it is a dot and a chevron.
- The chip menu is small and fast: the current Station and its state, a switch to another saved Station (with a filter at 5 or more), Connect a device, and Manage Station. Nothing else.
- The Station page opens at /station, with a Settings row that links to it. A grouped left list keeps two scopes visibly apart, with headings and a scope note.
- "This Station" (kept on Studio Mac, the same for everyone): Overview, Devices with access, People, Other Stations. "On this device" (saved in this browser only): Stations you can open.
- Devices with access is a real table (device, person, last used, access, change access, remove), with pending approvals on top. Access is edited inline under the row, capped by the person's role.
- Dialogs remain only for one-step tasks: the connect code and QR (it expires), the passkey check, and destructive confirms.
- "Open another Station" is an inline form on the page (address, name, and the two existing checkboxes), with "Enter a code" and "Scan a QR code" as focused steps.
- People and Other Stations move in as they are today, with wording changes and no new screens. SSH computers and broker routes stay hidden for v1.
- On a phone, the page is push navigation: a section list grouped by scope, then each section as its own screen with a back link.

## Before and after

| Task | Today | Agreed |
| --- | --- | --- |
| Connect a device from Home | 4 or more (account menu or Cmd-K, Connections, Computers, Add computer, "Control this Station from another") | 2 (Station menu in the header, Connect a device) |

## Screens

### `station-13` Station chip states

1. **The chip shows four states: Connected (dot only), Reconnecting…, Can't connect and Awaiting approval.** These are today's health labels, polled every 10 seconds. _(layout; slice 2.3)_

### `station-14` Station chip menu

On a phone: The same menu as a sheet.

1. **The current Station, its state and how it is reached.** _(layout; slice 2.3)_
2. **"Switch to · on this device".** The scope label says these saved Stations are per browser. _(copy; slice 2.3)_
3. **Connect a device opens the focused connect step.** _(layout; slice 2.3)_
4. **Manage Station opens the Station page.** Managing a Station happened in small dialogs. It now has a page with room for devices, people and other Stations. _(layout; slice 2.3)_
5. **Removed from the menu: Forget, Forget N unreachable, Details, Pair phone and the manager dialog.** They are all on the page now. _(layout; slice 2.3)_

### `station-15` Station chip menu with many Stations

1. **A filter appears at 5 or more saved Stations. Non-matching ones show as a count with "See all on the Station page".** The filter follows the existing rule. _(layout; slice 2.3)_

### `station-16` Station page: overview

On a phone: Push navigation: a section list grouped by scope, then each section as its own screen with a back link.

1. **The Station name, its state and how it is reached, with a "Rename" link.** Rename needs a Station name stored on the server. Today renaming edits only this browser's saved entry. Without that work the link is omitted. _(server work; slice 2.1)_
2. **A pending approval at the top, with Deny and Approve.** This is the existing pairing approval. _(layout; slice 2.2)_
3. **A "This Station" heading with "Kept on Studio Mac · same for everyone".** Today's Computers tab merges per-browser rows with per-Station rows in one list. _(copy; slice 2.1)_
4. **The Devices with access table.** It uses existing paired-device data, shown outside the manager for the first time. _(layout; slice 2.1)_
5. **People and Other Stations summaries.** _(layout; slice 2.1)_
6. **"On this device" with "Saved in this browser only".** Per-browser rows are never labelled as the Station's. _(copy; slice 2.1)_

### `station-17` Devices with access

On a phone: The table reflows to stacked rows.

1. **A table of devices, with person and last used.** "Last used" needs a backend check: paired devices record creation, and last-seen is not confirmed. "Person" comes from People, which exists. _(layout, backend check first; slice 2.2)_
2. **An "Allowed addresses" section: the addresses this Station accepts sign-in requests from, with add and remove.** Today this exists only as a command-line flag. It needs a stored, editable list and a passkey check on add. It is the fix for the first-run "device blocked" screen. _(new screen state, server work; slice 2.5)_
3. **"Let nearby devices find Studio Mac", On or Off.** This is the existing nearby discovery setting, moved here. It is not the same as "Find nearby" on Stations you can open. _(layout; slice 2.5)_

### `station-17b` Devices with access: access editor

On a phone: The editor stacks the four options.

1. **An inline access editor under the row: Read-only, Delegation, Standard, Participate in shared Projects.** Participate is disabled because a member's role caps it, which is the existing cap. _(layout; slice 2.2)_
2. **"Remove device" (danger) and "Save access".** _(layout; slice 2.2)_

### `station-18` Confirm it's you

On a phone: A sheet.

1. **"Confirm it's you" appears before raising access or removing a device.** The passkey check already guards revoke and remove. Whether raising access also needs it needs a backend check. _(backend check first; slice 2.2)_

### `station-19` Connect a device

On a phone: A full-height sheet.

1. **The "Connect a phone or computer" dialog. The footer says new devices appear in Devices with access.** This is the one connect-a-device screen. The Allowed addresses section sits beneath it. _(layout; slice 2.3)_

### `station-20` Stations you can open

On a phone: A sticky "Request access" button.

1. **The Stations this browser can open: switch, edit, make CLI default, forget, retry.** All are existing actions from the manager. _(layout; slice 2.1)_
2. **"Forgetting one removes it from this device; the Station itself is not changed."** This is today's copy, made prominent. _(copy; slice 2.1)_
3. **"Find nearby".** This is the existing Nearby Stations, now a page action. _(layout; slice 2.1)_
4. **"Open another Station" inline: address, name and two checkboxes, plus "Enter a code" and "Scan a QR code" steps.** The checkboxes are "Use X from this device" and "Let X send work to Y". It uses the existing two-checkbox dialog. _(layout; slice 2.1)_

### `station-21` Station menu on a phone

On a phone: This screen is phone only.

1. **On a phone that is itself a device, the menu says "This phone has Standard access", lists Stations on this phone and Manage Station.** There is no "Connect a device" entry. Today it appears only when the Station is local to the profile. _(layout; slice 2.3)_

## Feature calls

| Feature | Call | Reason |
| --- | --- | --- |
| Header chip menu: saved Stations | Keep | Switching stays in the menu. |
| Header chip menu: Forget and Forget N unreachable | Simplify | Forget moves to the page, under Stations you can open. |
| Header chip menu: Details | Simplify | Moves to the page Overview, as a Details card. |
| Header chip menu: Pair phone and Connect another device | Simplify | Becomes "Connect a device", which opens the focused step. |
| Header chip menu: Manage | Simplify | Becomes "Manage Station", which opens the Station page. |
| Manager: Stations | Simplify | Moves to the page, under Stations you can open. |
| Manager: Add Station and Request Access | Simplify | Become one inline form, "Open another Station". |
| Manager: Scan a pairing code and Enter a pairing code | Simplify | Become focused steps from the inline form. |
| Manager: Pair a Device | Simplify | Becomes the focused "Connect a device" step. |
| Manager: Paired Devices | Simplify | Becomes the Devices with access table with an inline access editor. |
| Manager: Nearby Stations | Simplify | Becomes "Find nearby", an action on Stations you can open. |
| The manager dialog itself | Keep | It must stay because first run and the unpaired screen use it. Its panels work both in the dialog and on the page. |
| Connections › Computers | Remove | Devices move to the page, peer Stations to Other Stations, and SSH and broker routes are hidden. |
| Settings › Devices (Pairing, People) | Simplify | Move to the page. Settings keeps a "Station" link. |
| Settings › Advanced › Device hosts | Hide for the first release | Hidden for v1 (SSH). |
| Settings row: Device helper URL | Hide for the first release | Hidden for v1. It points at the phone-under-test pane, a different meaning of "device". |
| Settings row: Device setup | Hide for the first release | Hidden for v1. |
| Settings row: Nearby discovery | Simplify | Moves to the Station page, under Allowed addresses. |
| Settings row: Accounts and sign-in | Simplify | Moves to Station › People as "Sign-in with local accounts". |
| Unpaired screen | Keep | Unchanged. It is the path before a connection exists, and reuses the same connect panels. |
| SSH computers and broker routes | Hide for the first release | Hidden for v1. |
| People | Keep | Moved into the page as it is today, with wording changes. |
| Other Stations | Keep | Moved into the page as it is today, with wording changes. |

## New work

| Work | Kind | Note |
| --- | --- | --- |
| Chip states | layout | Uses existing health. |
| Chip menu | layout |  |
| Station page shell and sections | new screen state | Reuses the existing panels. They are written for a dialog stack, so each must be lifted out and made to take its container's width. |
| Making the panels work in both the dialog and the page | layout | The dialog must survive for the unpaired path and phone guided connect. Native startup needs a check. |
| Inline "Open another Station" form | layout | Over the existing flow. |
| Station rename | server work | A new server-side Station name. |
| Device last-used time | backend check first |  |
| Passkey check when raising access | backend check first |  |
| Allowed addresses | server work | Today only a command-line flag. Needs a stored, editable list, a passkey check on add, and new UI. |
| People and Other Stations wording | copy | Panels re-hosted, with some copy changes. |

## Decisions taken during design

- Devices are about access to Station, not about what agents run on, so they left Connections for a Station page opened from the header chip.
- The owner asked for a page instead of small modals. Every management task is on the page; dialogs remain only for the expiring connect code, the passkey check and destructive confirms.
- The existing manager dialog has to stay as well, because first run and the unpaired screen use it. Its panels must work both in the dialog and on the page.
- The Device helper URL setting does not move here. It configures the phone-under-test pane, which is hidden for v1.
- People and Other Stations move into the page as they are today. They were not redesigned.
