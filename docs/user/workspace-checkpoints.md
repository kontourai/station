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

## Review and restore from the CLI

Request a preview from a running Station. Select the named Station you want to
restore on. The same target and credential must be used for confirmation.

```bash
station checkpoints restore --thread="$thread_id" --turn="$turn_id" --station=work
```

The preview lists affected paths, shows both tree hashes, and states when it
expires. Use `--phase=baseline` to preview the turn-start checkpoint. The
default is `settle`. After reviewing the paths, use the preview ID and current
tree hash shown in the output.

```bash
station checkpoints restore --thread="$thread_id" --turn="$turn_id" --station=work \
  --confirm --preview-id="$preview_id" --expected-current-tree-sha="$current_tree_sha"
```

Station checks the reviewed preview and workspace state again. If it refuses
the restore, resolve the reason and request a fresh preview. If the outcome is
uncertain, inspect the workspace before attempting another restore.

See the [CLI reference](../reference/cli.md#checkpoints) and
[restore owner](../../src-server/services/checkpoints/checkpoint-restore.ts).
