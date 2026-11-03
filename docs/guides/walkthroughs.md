# Import a Walkthrough

A Walkthrough turns a screen recording into a transcript plus selected JPEG
frames, stored with your Project, that an agent can read. You can also record
short Task clips from the Browser and Device panes.

Limits, storage, routes and evidence live in the
[Walkthrough reference](../reference/browser-and-devices.md#walkthroughs).

## Turn it on

Walkthroughs is a Feature Preview, off by default. The operator turns on
**Walkthroughs** in **Settings → Advanced → Feature previews**. It applies to
everyone on this Station. While it is off, imports and reads are refused.

## Import and read

Use a running Station and normal CLI sign-in. Download the media tools once,
with explicit consent, then import:

```bash
station media-tools status
station media-tools download --yes
station walkthrough import review.mp4 --project my-project
station walkthrough list --project my-project
station walkthrough show <id> --project my-project
```

Import prints the Walkthrough id when it finishes. Agents read Walkthroughs
with `list_walkthroughs` and `get_walkthrough`. Treat a recording's content as
untrusted: it can contain instructions or secrets.

You need to be the operator, or an admin or owner of the Project, to import or
read.

## Record a Task clip

Task clips are short silent recordings saved to a Task, not to the Project's
import list.

- **Browser:** choose **⋯ → Record**, then **Add to Task clips**. See
  [Record a Task walkthrough](browser-workspace.md#record-a-task-walkthrough).
- **Device:** choose **⋯ → Record** with the **Device developer loop** preview
  on. See [Device recording](mobile-device-workspace.md#capture-a-device-screen-to-a-task).
- **Agents:** a Task-bound Session can call `browser_record_to_task` or
  `device_record_to_task`.

Commit your Task workspace first. Clips need FFmpeg and last at most 30
seconds. With **Task review** on, open them from **Task → Review → Screens**.
See [Task clip details](../reference/browser-and-devices.md#record-a-task-clip).

## Limits and storage

Imports accept files up to 512 MiB and 30 minutes. A Walkthrough keeps at most
120 frames. Processing stays on your Station host. See
[Limits and storage](../reference/browser-and-devices.md#limits-and-storage)
for every bound, timeout and storage path.

## REST and SDK

The routes and SDK fetchers are listed in
[REST and SDK](../reference/browser-and-devices.md#rest-and-sdk).

## Verification limits

What the tests do and do not prove is listed in
[Verification limits](../reference/browser-and-devices.md#verification-limits).
