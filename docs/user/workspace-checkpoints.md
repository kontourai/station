# Restore workspace files from a chat checkpoint

When workspace checkpoints are enabled, Station can restore repository files
to the state captured before or after an earlier chat turn. The restore does
not change the conversation and cannot undo commands, network requests, or
other external effects caused by the turn.

From the chat timeline, choose **Restore workspace to here…** on the checkpoint
you want. Station shows a fresh preview of the affected paths. Review it, then
choose **Restore workspace**. Cancel closes the preview without changing files.

Station refuses the restore if another turn is starting or active in the same
repository, if the repository changed after the preview, if your Station or
session authority changed, or if the short-lived preview expired. Create a new
preview after resolving the refusal. If Station cannot confirm the outcome,
inspect the workspace before trying again.

The command-line equivalent is:

```bash
station checkpoints restore --thread=<threadId> --turn=<turnId> --confirm
```

The CLI also previews first and confirms that exact current tree. Use
`--phase=baseline` for the pre-turn checkpoint; the default `settle` phase is
the post-turn checkpoint.
