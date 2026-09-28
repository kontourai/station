# Restore workspace files from a chat checkpoint

When workspace checkpoints are enabled, Station can restore repository files
from snapshots associated with an earlier chat turn. The restore does
not change the conversation and cannot undo commands, network requests, or
other external effects caused by the turn.

Checkpoints cover tracked files and untracked files that Git does not ignore.
They are not a backup of ignored configuration, build output, or data outside
the repository. A turn without a captured checkpoint has nothing to restore;
checkpoints can also become unavailable after retention or Git object cleanup.

In a turn's available changed-files details, choose **Restore workspace to
here…**. This chat control selects the turn's `settle` snapshot; it does not
offer a baseline/settle selector and is hidden during replay. Station shows a
fresh preview of the affected paths. Review it, then
choose **Restore workspace**. Cancel closes the preview without changing files.
The preview lists at most 200 paths and tells you when more are omitted.

Station refuses the restore if another turn is starting or active in the same
Git working tree, if its files changed after the preview, if your Station or
session authority changed, or if the short-lived preview expired. Create a new
preview after resolving the refusal. If Station cannot confirm the outcome,
inspect the workspace before trying again.

Capture is queued from turn-start and turn-terminal events. It does not block
engine execution while taking a snapshot, so the phase name is not a guarantee
of the exact filesystem state immediately before or after the turn. Review the
restore preview rather than assuming it undoes precisely that turn's edits.
The capture-timing contract is tracked in
[#2737](https://github.com/kontourai/station/issues/2737).

## Command-line status

The CLI exposes this command shape:

```bash
station checkpoints restore --thread=<threadId> --turn=<turnId> --confirm
```

Its current implementation does not use Station's shared authenticated client
or saved-Station selection, so it is not a working equivalent on a normally
protected Station. It also immediately confirms the returned preview without
showing its affected paths. Use the chat preview/confirmation flow above until
[#2734](https://github.com/kontourai/station/issues/2734) fixes those gaps.

The command defaults to the `settle` checkpoint; `--phase=baseline`
selects the snapshot associated with turn start. These describe the current parser, not a
verified CLI restore journey.

The [restore owner](../../src-server/services/checkpoints/checkpoint-restore.ts)
checks the preview and workspace state; the
[chat control](../../src-ui/src/components/chat/CheckpointRestoreButton.tsx)
owns the visible confirmation. Source and fixture tests do not prove that a
restore was exercised in a packaged app on every platform.
