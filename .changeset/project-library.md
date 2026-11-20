---
"@kontourai/station-contracts": minor
"@kontourai/station-sdk": minor
---

Add the Project Library. Contracts add `@kontourai/station-contracts/project-library` (`ProjectLibraryPage`, `ProjectLibraryItem`, `projectLibraryUploadPath`, `filterProjectLibraryItems`, `projectLibraryTasks`, `sortProjectLibraryItems`) and the optional `projectLibrary` capability flag. The SDK adds `@kontourai/station-sdk/project-library` (`useProjectLibraryQuery`, `useUploadProjectLibraryFileMutation`, `useDeleteProjectLibraryFileMutation`, `downloadProjectLibraryContent`, `readProjectLibraryCapability`) for `GET/PUT/DELETE /api/projects/:slug/library…`, available while the `project-library` Feature Preview is on.
