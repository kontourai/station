import type { ProjectConfig } from '../../contexts/ProjectsContext';

export type ProjectForm = Pick<
  ProjectConfig,
  | 'name'
  | 'icon'
  | 'description'
  | 'defaultModel'
  | 'defaultWorkspaceIsolation'
  | 'defaultEnvironment'
  | 'workingDirectory'
  | 'agents'
>;

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
