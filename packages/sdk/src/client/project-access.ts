import { isPrincipalRef } from '@kontourai/station-contracts/principal';
import {
  PROJECT_MEMBER_ROLES,
  PROJECT_MEMBERSHIP_VERSION,
  type ProjectAccessAdministrationView,
  type ProjectInvitationView,
  type ProjectMemberRole,
  type ProjectMembershipScope,
} from '@kontourai/station-contracts/project-membership';
import { z } from 'zod/v3';
import { type ClientRequestOptions, getJson, mutateJson } from './http';
import { unwrapProjectResponse } from './project-response';

const scopeSchema = z
  .object({
    stationId: z.string().min(1),
    localProjectId: z.string().min(1),
    localProjectSlug: z.string().min(1),
    portableProjectId: z.string().min(1),
  })
  .strict();
const roleSchema = z.enum(['owner', 'admin', 'contributor', 'viewer']);
const invitationSchema = z
  .object({
    id: z.string().min(1),
    recipientEmail: z.string().email().nullable(),
    role: z.enum(['admin', 'contributor', 'viewer']),
    actions: z.array(z.string()),
    invitedBy: z.custom(isPrincipalRef),
    status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();
const viewSchema = z
  .object({
    version: z.literal(PROJECT_MEMBERSHIP_VERSION),
    actingPrincipal: z.custom(isPrincipalRef),
    invitationOrigin: z.string().url().optional(),
    scope: scopeSchema,
    members: z.array(
      z
        .object({
          principal: z.custom(isPrincipalRef),
          role: roleSchema,
          actions: z.array(z.string()),
          status: z.enum(['active', 'revoked']),
          revision: z.number().int().positive(),
          grantedBy: z.custom(isPrincipalRef),
          updatedAt: z.string().datetime(),
        })
        .strict(),
    ),
    invitations: z.array(invitationSchema),
  })
  .strict();
function administration(
  value: unknown,
  slug: string,
): ProjectAccessAdministrationView {
  const parsed = viewSchema.safeParse(value);
  if (!parsed.success || parsed.data.scope.localProjectSlug !== slug)
    throw new Error(
      'Project access response has an incompatible identity or schema.',
    );
  for (const entry of [...parsed.data.members, ...parsed.data.invitations]) {
    const expected = PROJECT_MEMBER_ROLES[entry.role] as readonly string[];
    if (
      entry.actions.length !== expected.length ||
      expected.some((action) => !entry.actions.includes(action))
    )
      throw new Error('Project access response has incompatible permissions.');
  }
  if (
    !parsed.data.members.some(
      (member) =>
        member.principal.id === parsed.data.actingPrincipal.id &&
        member.status === 'active' &&
        member.actions.includes('manage-members'),
    )
  )
    throw new Error(
      'Project access response does not establish administration authority.',
    );
  return parsed.data as ProjectAccessAdministrationView;
}
export async function getProjectAccess(
  apiBase: string,
  slug: string,
  options?: ClientRequestOptions,
): Promise<ProjectAccessAdministrationView> {
  return administration(
    await unwrapProjectResponse<unknown>(
      await getJson(
        `${apiBase}/api/projects/${encodeURIComponent(slug)}/access`,
        options,
      ),
    ),
    slug,
  );
}

export type ProjectAccessCommand =
  | { kind: 'enable'; localProjectId: string }
  | {
      kind: 'invite';
      scope: ProjectMembershipScope;
      email: string | null;
      role: Exclude<ProjectMemberRole, 'owner'>;
      expiresAt: string;
    }
  | {
      kind: 'revoke-invitation';
      scope: ProjectMembershipScope;
      invitationId: string;
    }
  | {
      kind: 'change-member';
      scope: ProjectMembershipScope;
      principalId: string;
      revision: number;
      role: Exclude<ProjectMemberRole, 'owner'>;
      status: 'active' | 'revoked';
    }
  | { kind: 'transfer'; scope: ProjectMembershipScope; recipientId: string };
export type ProjectAccessCommandResult =
  | { kind: 'enabled'; view: ProjectAccessAdministrationView }
  | { kind: 'invited'; invitation: ProjectInvitationView; token: string }
  | { kind: 'changed' };

export async function changeProjectAccess(
  apiBase: string,
  slug: string,
  input: ProjectAccessCommand,
  options?: ClientRequestOptions,
): Promise<ProjectAccessCommandResult> {
  const command = structuredClone(input);
  if ('scope' in command && command.scope.localProjectSlug !== slug)
    throw new Error('Project access command names another Project.');
  const { kind, ...data } = command;
  const suffix =
    kind === 'enable'
      ? '/enable'
      : kind === 'invite'
        ? '/invitations'
        : kind === 'change-member'
          ? '/members'
          : kind === 'transfer'
            ? '/transfer'
            : `/invitations/${encodeURIComponent((command as Extract<ProjectAccessCommand, { kind: 'revoke-invitation' }>).invitationId)}/revoke`;
  const body =
    command.kind === 'revoke-invitation' ? { scope: command.scope } : data;
  const result = await unwrapProjectResponse<unknown>(
    await mutateJson(
      `${apiBase}/api/projects/${encodeURIComponent(slug)}/access${suffix}`,
      'POST',
      { ...options, readOnly: false },
      body,
    ),
  );
  if (kind === 'enable')
    return { kind: 'enabled', view: administration(result, slug) };
  if (command.kind === 'invite') {
    const parsed = z
      .object({
        invitation: invitationSchema,
        token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      })
      .strict()
      .safeParse(result);
    if (!parsed.success)
      throw new Error('Project invitation response is incompatible.');
    if (
      parsed.data.invitation.recipientEmail !==
        (command.email === null ? null : command.email.trim().toLowerCase()) ||
      parsed.data.invitation.role !== command.role ||
      Date.parse(parsed.data.invitation.expiresAt) !==
        Date.parse(command.expiresAt)
    )
      throw new Error(
        'Project invitation response differs from the requested recipient or permissions.',
      );
    return { kind: 'invited', ...parsed.data } as ProjectAccessCommandResult;
  }
  if (
    !z
      .object({ changed: z.literal(true) })
      .strict()
      .safeParse(result).success
  )
    throw new Error('Project access change was not confirmed.');
  return { kind: 'changed' };
}
