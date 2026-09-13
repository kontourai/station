import {
  DEPLOYMENT_AUTHENTICATION_BASE_PATH,
  DEPLOYMENT_AUTHENTICATION_VERSION,
  type DeploymentAuthenticationDescriptor,
} from '@kontourai/station-contracts/deployment-authentication';
import {
  isPrincipalRef,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import {
  PROJECT_MEMBER_ACTIONS,
  PROJECT_MEMBER_ROLES,
  type ProjectInvitationPreview,
} from '@kontourai/station-contracts/project-membership';
import { z } from 'zod/v3';
import { apiErrorMessage } from './api-error-message';
import { getJson, mutateJson, StationHttpError } from './http';

const path = z
  .string()
  .regex(/^\/[a-z0-9][a-z0-9/_-]*$/)
  .refine((value) => !value.includes('//'));
const login = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.enum(['email-password', 'username-password']),
      signInPath: path,
      signUpPath: path.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('redirect'), startPath: path }).strict(),
]);
async function read(response: Response): Promise<unknown> {
  const value = (await response.json().catch(() => undefined)) as
    | { data?: unknown; error?: unknown }
    | undefined;
  if (!response.ok)
    throw new StationHttpError(
      response.status,
      apiErrorMessage(
        value ?? {},
        'The account request could not be completed.',
      ),
    );
  return value?.data ?? value;
}

/** Account cookies only: no personal/operator bearer is attached or established. */
export async function getAccountAuthentication(
  apiBase: string,
): Promise<DeploymentAuthenticationDescriptor> {
  const value = await read(
    await getJson(`${apiBase}${DEPLOYMENT_AUTHENTICATION_BASE_PATH}`, {
      authentication: 'omit',
      timeoutMs: 15_000,
      maxResponseBytes: 32 * 1024,
    }),
  );
  const parsed = z
    .object({
      version: z.literal(DEPLOYMENT_AUTHENTICATION_VERSION),
      issuer: z.string().min(1),
      displayName: z.string().min(1),
      endpoints: z
        .array(
          z
            .object({
              path,
              methods: z.array(z.enum(['GET', 'POST'])),
              operation: z.string(),
            })
            .strict(),
        )
        .max(32),
      sessionCookies: z.array(z.string()).max(4),
      login: login.optional(),
    })
    .strict()
    .safeParse(value);
  if (!parsed.success)
    throw new Error('This Station has an incompatible sign-in interface.');
  return parsed.data as DeploymentAuthenticationDescriptor;
}
export interface AccountSessionView {
  principal: PrincipalRef;
  issuer: string;
  expiresAt: string;
  contacts: { kind: 'email'; value: string; verifiedAt: string }[];
}
export async function getAccountSession(
  apiBase: string,
): Promise<AccountSessionView | null> {
  const response = await getJson(
    `${apiBase}${DEPLOYMENT_AUTHENTICATION_BASE_PATH}/session`,
    { authentication: 'omit', timeoutMs: 15_000, maxResponseBytes: 32 * 1024 },
  );
  if (response.status === 401) return null;
  const parsed = z
    .object({
      principal: z.custom<PrincipalRef>(isPrincipalRef),
      issuer: z.string().min(1),
      expiresAt: z.string().datetime(),
      contacts: z
        .array(
          z
            .object({
              kind: z.literal('email'),
              value: z.string().email(),
              verifiedAt: z.string().datetime(),
            })
            .strict(),
        )
        .max(16),
    })
    .strict()
    .safeParse(await read(response));
  if (!parsed.success)
    throw new Error('This Station returned an incompatible account identity.');
  return parsed.data;
}
export async function runAccountOperation(
  apiBase: string,
  endpoint: string,
  body: Record<string, unknown>,
  invitation?: string,
): Promise<unknown> {
  if (!path.safeParse(endpoint).success)
    throw new Error('Invalid account operation.');
  return read(
    await mutateJson(
      `${apiBase}${DEPLOYMENT_AUTHENTICATION_BASE_PATH}${endpoint}`,
      'POST',
      {
        authentication: 'omit',
        readOnly: false,
        timeoutMs: 15_000,
        maxResponseBytes: 32 * 1024,
        ...(invitation
          ? { headers: { 'x-station-invitation': invitation } }
          : {}),
      },
      structuredClone(body),
    ),
  );
}

/** Preview proof stays in the POST body, never an HTTP URL or query cache key. */
export async function getProjectInvitationPreview(
  apiBase: string,
  token: string,
): Promise<ProjectInvitationPreview> {
  const parsed = z
    .object({
      projectName: z.string().min(1).max(512),
      inviterName: z.string().min(1).max(512),
      role: z.enum(['viewer', 'contributor', 'admin']),
      actions: z.array(z.enum(PROJECT_MEMBER_ACTIONS)),
      expiresAt: z.string().datetime(),
      recipientEmail: z.string().email().nullable(),
    })
    .strict()
    .parse(
      await runAccountOperation(apiBase, '/invitation-preview', { token }),
    );
  const expected = PROJECT_MEMBER_ROLES[parsed.role];
  if (
    parsed.actions.length !== expected.length ||
    !expected.every((action) => parsed.actions.includes(action))
  )
    throw new Error('Invitation permissions are incompatible.');
  return parsed;
}
