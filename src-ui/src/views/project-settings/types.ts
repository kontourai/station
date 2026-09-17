import type { ProjectConfig } from '../../contexts/ProjectsContext';

/**
 * What the workspace picker can hold. `'inherit'` is a FORM state, not a
 * stored one — the record spells "no choice here" by not carrying the field
 * at all (#2144 slice 2). The form needs a value for it because a `<select>`
 * has no absent, and `buildProjectSavePayload` turns it back into the `null`
 * the route drops the override on.
 *
 * Without this state the picker had no way to say "inherit": it seeded
 * `?? 'shared'`, so saving a RENAME on a project that had never chosen a
 * workspace mode wrote `'shared'` into it and pinned it away from the
 * Station default nobody had asked to leave.
 */
export type ProjectWorkspaceIsolationChoice = 'inherit' | 'shared' | 'worktree';

export type ProjectForm = Pick<
  ProjectConfig,
  | 'name'
  | 'icon'
  | 'description'
  | 'defaultModel'
  | 'defaultProviderId'
  | 'defaultEnvironment'
  | 'workingDirectory'
  | 'agents'
> & {
  defaultWorkspaceIsolation: ProjectWorkspaceIsolationChoice;
};

export interface DocMeta {
  id: string;
  filename: string;
  chunkCount: number;
  createdAt: string;
}

export interface KnowledgeStatus {
  provider: string;
  documentCount: number;
  totalChunks: number;
  lastIndexed: string | null;
}
