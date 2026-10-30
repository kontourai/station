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
  'manage-layouts',
  'manage-compute',
] as const;
export type ProjectMemberAction = (typeof PROJECT_MEMBER_ACTIONS)[number];

/** Permission presets. Execution still requires an independent receiver/compute grant. */
export const PROJECT_MEMBER_ROLES = {
  viewer: ['view'],
  contributor: ['view', 'discuss', 'edit', 'execute'],
  admin: [
    'view',
    'discuss',
    'edit',
    'execute',
    'approve',
    'manage-members',
    'manage-layouts',
  ],
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

/**
 * Why `GET /api/projects/:slug/access` refused, sent as the 403 envelope's
 * `details` so a client never has to guess the state from the status alone.
 *
 * The server reads whether the Project is shared only after the caller has
 * shown the authority `POST .../access/enable` requires. Every other caller
 * gets `undisclosed` whether or not the Project is shared, so the refusal
 * tells them nothing new about the Project.
 *
 * - `off`: sharing has not been turned on, and this caller can turn it on.
 * - `on`: the Project is shared, but this caller does not manage its people.
 * - `undisclosed`: this caller cannot turn sharing on from here and is not
 *   told whether the Project is shared.
 */
export type ProjectAccessRefusalDetails =
  | { readonly sharing: 'off'; readonly canEnable: true }
  | { readonly sharing: 'on'; readonly canEnable: false }
  | { readonly sharing: 'undisclosed'; readonly canEnable: false };

/** Boundary parser for {@link ProjectAccessRefusalDetails}. `undefined` for any other value, including the absent details of an older Station. */
export function parseProjectAccessRefusalDetails(
  value: unknown,
): ProjectAccessRefusalDetails | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const { sharing, canEnable, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return undefined;
  if (sharing === 'off' && canEnable === true) return { sharing, canEnable };
  if ((sharing === 'on' || sharing === 'undisclosed') && canEnable === false)
    return { sharing, canEnable };
  return undefined;
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

/** A committed invitation acceptance; membership grants no Device access. */
export interface ProjectInvitationAcceptance {
  readonly scope: ProjectMembershipScope;
  readonly grantsDeviceAccess: false;
}
