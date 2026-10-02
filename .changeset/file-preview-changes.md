---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

The File Preview's Changes view: one previewed file's diff against HEAD.
`workspace-file-preview` gains `WorkspaceFileChanges` (`changed`, `unchanged`,
`untracked`, `no-commits`, `not-a-repository`, `oversized` or `refused` with
a reason), `WorkspaceFileChangesRequest` and
`WORKSPACE_FILE_CHANGES_MAX_BYTES`. The SDK's `workspace-file-preview`
subpath adds `readProjectWorkspaceFileChanges` (`POST
/api/projects/:slug/file-preview/changes`, the preview's path and session
rules), `useProjectWorkspaceFileChangesQuery`, which asks again after a `503
repository-busy` answer when the server's `Retry-After` says to, and
`isRepositoryBusyError`, which names that answer. The read runs on the
Project's own repository through the same confined read as the coding diff;
a repository that is being written answers busy, not a refusal.
