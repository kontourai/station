import type { AgentSpec } from './agent.js';
import type { ProjectMemberRole } from './project-membership.js';
import type { ToolOrigin } from './tool.js';

export interface ToolLibrarySource {
  id: string;
  kind: 'integration' | 'plugin';
  name: string;
  description?: string;
  from: string;
  origin?: ToolOrigin;
  installed: boolean;
  enabled: boolean;
  permitted: boolean;
  operatorOnly: boolean;
  sharedWithProjects?: boolean;
  personalAccount?: boolean;
  providesTools?: boolean;
  serverIds?: string[];
  tools: Array<{
    name: string;
    title?: string;
    description?: string;
    group?: string;
    readOnly?: boolean;
    classificationSource?: 'station' | 'publisher';
    disabled?: boolean;
  }>;
  request?: { id: string; status: ToolAccessRequest['status'] };
}

export interface ProjectToolPolicy {
  mode: 'all' | 'selected';
  sources: string[];
  revision: number;
}

export interface ToolAccessRequest {
  id: string;
  projectId: string;
  projectSlug: string;
  projectName: string;
  requesterId: string;
  requesterName: string;
  sourceId: string;
  sourceKind: ToolLibrarySource['kind'];
  sourceName: string;
  registryId?: string;
  status: 'pending' | 'setting-up' | 'available' | 'declined' | 'failed';
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface OwnAccessView {
  principalId: string;
  name: string;
  station: { name: string; operator: boolean; canInstallTools: boolean };
  projects: Array<{
    id: string;
    slug: string;
    name: string;
    role: ProjectMemberRole | 'operator';
    canManageAgents: boolean;
    canManageTools: boolean;
    canExecute: boolean;
  }>;
}

export interface ToolLibraryView {
  sources: ToolLibrarySource[];
  operator: boolean;
  canManageAgents: boolean;
  canManagePolicy: boolean;
  project?: { id: string; slug: string; name: string };
  policy: ProjectToolPolicy;
  engines?: Array<{ id: string; name: string; engineId?: string }>;
}

export interface ProjectAgentDraft {
  name: string;
  description?: string;
  prompt: string;
  engineId: string;
  tools: NonNullable<AgentSpec['tools']>;
}

export interface ProjectAuthoredAgent {
  slug: string;
  projectId: string;
  draft: ProjectAgentDraft;
}
