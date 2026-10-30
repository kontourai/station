---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Add `WorkspaceVisualFileRefusal`, `WORKSPACE_VISUAL_FILE_REFUSAL_STATUS` and `workspaceVisualFileUnavailableReason` to the `workspace-file-preview` contract subpath. `readProjectWorkspaceVisualFile` now throws `WorkspaceVisualFileError` with `status` and `reason` (the server's refusal, `unauthorized`, `server-error` or `unavailable`) instead of one message for every failure.
