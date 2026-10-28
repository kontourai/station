import { isPrincipalRef } from '@kontourai/station-contracts/principal';
import {
  PROJECT_MEMBER_ROLES,
  PROJECT_MEMBERSHIP_VERSION,
  type ProjectAccessAdministrationView,
  type ProjectInvitationView,
  type ProjectMemberRole,
  type ProjectMembershipScope,
  type ProjectSharingEnablement,
} from '@kontourai/station-contracts/project-membership';
import { z } from 'zod/v3';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  readJsonBody,
} from './http';
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

/**
 * Caller-captured mutation intent for the cookie-replacement race: the
 * principal id the acting page was rendered for. The server compares it
 * against freshly authenticated authority before committing and refuses on
 * mismatch — a client claim that grants nothing. Omit it only on call paths
 * that never cross an HttpOnly-cookie authority boundary (the operator
 * console keeps working unchanged).
 */
export interface ProjectAccessMutationIntent {
  expectedActor?: string;
}

export type ProjectAccessCommand =
  | { kind: 'enable'; localProjectId: string }
  | ({
      kind: 'invite';
      scope: ProjectMembershipScope;
      email: string | null;
      role: Exclude<ProjectMemberRole, 'owner'>;
      expiresAt: string;
    } & ProjectAccessMutationIntent)
  | ({
      kind: 'revoke-invitation';
      scope: ProjectMembershipScope;
      invitationId: string;
    } & ProjectAccessMutationIntent)
  | ({
      kind: 'change-member';
      scope: ProjectMembershipScope;
      principalId: string;
      revision: number;
      role: Exclude<ProjectMemberRole, 'owner'>;
      status: 'active' | 'revoked';
    } & ProjectAccessMutationIntent)
  | ({
      kind: 'transfer';
      scope: ProjectMembershipScope;
      recipientId: string;
    } & ProjectAccessMutationIntent);
/** A pending consent-origin passkey review (#4306); nothing has changed yet. */
export interface ProjectSharingStepUp {
  id: string;
  reviewUrl: string;
  expiresAt: number;
}
export type ProjectAccessCommandResult =
  | { kind: 'enabled'; view: ProjectAccessAdministrationView }
  | { kind: 'step-up-required'; transaction: ProjectSharingStepUp }
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
  // The revoke leaf previously carried only the Project scope; the
  // caller-captured actor precondition rides along wherever present, so a
  // stale page cannot revoke as a substituted principal either.
  const body =
    command.kind === 'revoke-invitation'
      ? {
          scope: command.scope,
          ...(command.expectedActor === undefined
            ? {}
            : { expectedActor: command.expectedActor }),
        }
      : data;
  const response = await mutateJson(
    `${apiBase}/api/projects/${encodeURIComponent(slug)}/access${suffix}`,
    'POST',
    { ...options, readOnly: false },
    body,
  );
  if (kind === 'enable' && response.status === 202)
    return {
      kind: 'step-up-required',
      transaction: stepUpTransaction(await readJsonBody(response), apiBase),
    };
  const result = await unwrapProjectResponse<unknown>(response);
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

/** Extract a code for the already-selected Station; never dial or trust the link's origin. */
export function readProjectInvitationToken(value: string): string | undefined {
  const input = value.trim();
  const token = /^[A-Za-z0-9_-]{43}$/u;
  if (token.test(input)) return input;
  try {
    const link = new URL(input);
    if (
      !['http:', 'https:'].includes(link.protocol) ||
      link.username ||
      link.password ||
      link.search ||
      link.pathname !== '/account/join'
    )
      return undefined;
    const fields = new URLSearchParams(link.hash.slice(1));
    const invitation = fields.get('invitation');
    return fields.size === 1 && invitation && token.test(invitation)
      ? invitation
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Accept only a review on the separate HTTPS consent origin of this same
 * host name; the app origin never runs a passkey ceremony.
 */
function stepUpTransaction(
  body: unknown,
  apiBase: string,
): ProjectSharingStepUp {
  const parsed = z
    .object({
      status: z.literal('step_up_required'),
      transaction: z.object({
        id: z.string().min(1).max(128),
        reviewUrl: z.string().url(),
        expiresAt: z.number().finite(),
      }),
    })
    .safeParse(body);
  if (!parsed.success) throw new Error('Invalid step-up response.');
  const review = new URL(parsed.data.transaction.reviewUrl);
  const app = new URL(apiBase);
  if (
    review.protocol !== 'https:' ||
    review.hostname !== app.hostname ||
    review.origin === app.origin
  )
    throw new Error('Invalid step-up response.');
  return { ...parsed.data.transaction, reviewUrl: review.href };
}

const enablementSchema = z.union([
  z.object({ enable: z.enum(['direct', 'operator-passkey', 'unavailable']) }),
  z.object({
    enable: z.literal('operator-sign-in'),
    signInUrl: z.string().url(),
  }),
]);

/** How this caller may turn on sharing for a Project; describes the caller only. */
export async function getProjectSharingEnablement(
  apiBase: string,
  slug: string,
  options?: ClientRequestOptions,
): Promise<ProjectSharingEnablement> {
  const parsed = enablementSchema.safeParse(
    await unwrapProjectResponse<unknown>(
      await getJson(
        `${apiBase}/api/projects/${encodeURIComponent(slug)}/access/enablement`,
        options,
      ),
    ),
  );
  if (!parsed.success)
    throw new Error('Project sharing enablement response is incompatible.');
  const data = parsed.data;
  if (data.enable !== 'operator-sign-in') return { enable: data.enable };
  return new URL(data.signInUrl).protocol === 'https:'
    ? { enable: 'operator-sign-in', signInUrl: data.signInUrl }
    : { enable: 'unavailable' };
}

/** The status of a pending step-up; only the session that opened it may read it. */
export async function getProjectSharingStepUpStatus(
  apiBase: string,
  transactionId: string,
  options?: ClientRequestOptions,
): Promise<
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'target_changed'
  | 'session_ended'
> {
  const response = await getJson(
    `${apiBase}/api/pairing/device-access-transactions/${encodeURIComponent(transactionId)}`,
    {
      ...options,
      headers: { ...options?.headers, 'X-Station-Background-Refresh': '1' },
    },
  );
  const parsed = z
    .object({
      status: z.enum([
        'pending',
        'approved',
        'denied',
        'expired',
        'target_changed',
        'session_ended',
      ]),
    })
    .safeParse(await readJsonBody(response));
  if (!response.ok || !parsed.success)
    throw new Error('The passkey review status is unavailable.');
  return parsed.data.status;
}
