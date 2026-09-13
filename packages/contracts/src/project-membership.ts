import type { PrincipalRef } from './principal.js';

export const PROJECT_MEMBERSHIP_VERSION =
  'station.project-membership/v1' as const;
export const PROJECT_MEMBER_ACTIONS = [
  'view',
  'discuss',
  'edit',
  'execute',
  'approve',
  'manage-members',
  'manage-extensions',
  'manage-compute',
] as const;
export type ProjectMemberAction = (typeof PROJECT_MEMBER_ACTIONS)[number];

/** Permission presets. Execution still requires an independent receiver/compute grant. */
export const PROJECT_MEMBER_ROLES = {
  viewer: ['view'],
  contributor: ['view', 'discuss', 'edit', 'execute'],
  admin: ['view', 'discuss', 'edit', 'execute', 'approve', 'manage-members'],
  owner: [...PROJECT_MEMBER_ACTIONS],
} as const satisfies Record<string, readonly ProjectMemberAction[]>;
export type ProjectMemberRole = keyof typeof PROJECT_MEMBER_ROLES;

/** Exact local incarnation and portable Project identity at its authoritative Station. */
export interface ProjectMembershipScope {
  stationId: string;
  localProjectId: string;
  localProjectSlug: string;
  portableProjectId: string;
}

export interface ProjectMemberView {
  principal: PrincipalRef;
  role: ProjectMemberRole;
  actions: readonly ProjectMemberAction[];
  status: 'active' | 'revoked';
  revision: number;
  grantedBy: PrincipalRef;
  updatedAt: string;
}

export interface ProjectInvitationView {
  id: string;
  /** Null is an explicit single-use link invitation; a string requires that verified email. */
  recipientEmail: string | null;
  role: Exclude<ProjectMemberRole, 'owner'>;
  actions: readonly ProjectMemberAction[];
  invitedBy: PrincipalRef;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
  createdAt: string;
}

export interface ProjectAccessAdministrationView {
  version: typeof PROJECT_MEMBERSHIP_VERSION;
  actingPrincipal: PrincipalRef;
  /** Browser-facing authentication origin; absent when invitation login is unavailable. */
  invitationOrigin?: string;
  scope: ProjectMembershipScope;
  members: readonly ProjectMemberView[];
  invitations: readonly ProjectInvitationView[];
}

/** Minimal disclosure to a holder of a current invitation; no files, paths or member inventory. */
export interface ProjectInvitationPreview {
  projectName: string;
  inviterName: string;
  role: Exclude<ProjectMemberRole, 'owner'>;
  actions: readonly ProjectMemberAction[];
  expiresAt: string;
  recipientEmail: string | null;
}
