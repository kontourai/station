import { z } from 'zod';

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
export const PENDING_TTL = 10 * MINUTE;
export const CODE_TTL = MINUTE;
export const IDLE_TTL = 7 * DAY;
export const GRANT_TTL = 30 * DAY;
export const ACCESS_TTL = 60 * MINUTE;

const timestamp = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const scope = z.enum(['station-control:read', 'station-control:full']);
const projectScopeSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('project'), projectId: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal('global') }).strict(),
]);
const metadataSchema = z
  .object({
    redirect_uris: z.array(z.string().max(2048)).min(1).max(5),
    client_name: z.string().max(128).optional(),
    software_id: z.string().max(128).optional(),
    application_type: z.enum(['native', 'web']),
    client_uri: z.string().max(2048).optional(),
    logo_uri: z.string().max(2048).optional(),
    policy_uri: z.string().max(2048).optional(),
    tos_uri: z.string().max(2048).optional(),
    contacts: z.array(z.string().max(254)).max(3).optional(),
    scope: z.string().optional(),
    grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])),
    response_types: z.array(z.literal('code')),
    token_endpoint_auth_method: z.literal('none'),
  })
  .strict();
const clientSchema = z.object({
  id: z.string(),
  version: z.literal(1),
  metadata: metadataSchema,
  digest,
  createdAt: timestamp,
  lastGrantAt: timestamp.nullable(),
});
const requestSchema = z.object({
  bootId: z.string().min(1),
  id: z.string(),
  version: z.number().int().positive(),
  clientId: z.string(),
  registrationDigest: digest,
  ticketHash: digest,
  comparisonHash: digest,
  nonceHash: digest,
  stateDigest: digest,
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  redirectUri: z.string(),
  resource: z.string(),
  scopes: z.array(scope),
  peer: z.string().nullable(),
  createdAt: timestamp,
  expiresAt: timestamp,
  state: z.enum([
    'pending',
    'approved',
    'coded',
    'active',
    'denied',
    'expired',
    'replaced',
  ]),
});
const actorSchema = z
  .object({
    kind: z.enum(['host', 'operator-passkey']),
    id: z.string().min(1),
    authorityRevision: z.string().min(1),
  })
  .strict();
export const selectionSchema = z
  .object({
    delegatingPrincipalId: z.string().min(1),
    actor: actorSchema,
    projectScope: projectScopeSchema,
    accessLevel: z.literal('read-only'),
    scopes: z.tuple([z.literal('station-control:read')]),
    expiresAt: timestamp,
    redirectPolicyRevision: z.number().int().nonnegative(),
  })
  .strict();
const supersessionSchema = z
  .object({
    grantId: z.string(),
    expectedVersion: z.number().int().positive(),
    expectedDigest: digest,
  })
  .strict();
const intentSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  requestVersion: z.number().int().positive(),
  registrationDigest: digest,
  selection: selectionSchema,
  supersessions: z.array(supersessionSchema).max(100),
  createdAt: timestamp,
});
const grantSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  clientId: z.string(),
  registrationDigest: digest,
  redirectUri: z.string(),
  issuer: z.string(),
  resource: z.string(),
  stationId: z.string(),
  requestedScopes: z.array(scope),
  selection: selectionSchema,
  familyId: z.string(),
  createdAt: timestamp,
  lastUsedAt: timestamp,
  expiresAt: timestamp,
  state: z.enum(['active', 'revoked', 'expired']),
  reason: z
    .enum([
      'refresh_replay',
      'code_replay',
      'idle',
      'absolute',
      'superseded',
      'revoked',
      'authority',
      'changed',
      'redirect_origin_removed',
    ])
    .nullable(),
});
const familySchema = z.object({
  id: z.string(),
  grantId: z.string(),
  state: z.enum(['active', 'revoked', 'expired']),
  lastUsedAt: timestamp,
  sequence: z.number().int().nonnegative(),
});
const refreshSchema = z.object({
  hash: digest,
  familyId: z.string(),
  grantId: z.string(),
  clientId: z.string(),
  resource: z.string(),
  sequence: z.number().int().nonnegative(),
  issuedAt: timestamp,
  usedAt: timestamp.nullable(),
  retainUntil: timestamp,
});
const accessSchema = z.object({
  hash: digest,
  grantId: z.string(),
  familyId: z.string(),
  version: z.number().int().positive(),
  clientId: z.string(),
  issuer: z.string(),
  resource: z.string(),
  stationId: z.string(),
  subject: z.string(),
  scopes: z.array(scope),
  expiresAt: timestamp,
});
const codeSchema = z.object({
  hash: digest,
  requestId: z.string(),
  requestVersion: z.number().int().positive(),
  intentId: z.string(),
  clientId: z.string(),
  redirectUri: z.string(),
  resource: z.string(),
  challenge: z.string(),
  expiresAt: timestamp,
  failures: z.number().int().nonnegative(),
  familyId: z.string().nullable(),
  retainUntil: timestamp,
});
const ticketSchema = z.object({
  hash: digest,
  createdAt: timestamp,
  expiresAt: timestamp,
});
const tombstoneSchema = z.object({
  id: z.string(),
  label: z.string().max(128),
  reason: z.enum(['expired', 'denied', 'revoked']),
  expiresAt: timestamp,
});
const eventSchema = z.object({
  stationId: z.string(),
  actor: actorSchema.optional(),
  projectScope: projectScopeSchema.optional(),
  accessLevel: z.literal('read-only').optional(),
  id: z.string(),
  at: timestamp,
  kind: z.enum([
    'registration',
    'requested',
    'approved',
    'activated',
    'terminal',
    'request-ended',
    'retired',
    'policy-changed',
    'decision',
  ]),
  clientId: z.string().optional(),
  requestId: z.string().optional(),
  grantId: z.string().optional(),
  decisionId: z.string().optional(),
  version: z.number().optional(),
  reason: z.string().optional(),
  deliveredAt: timestamp.nullable(),
});
const quotaSchema = z.object({
  day: z.number().int(),
  count: z.number().int().nonnegative(),
});

export const recordSchemas = {
  client: clientSchema,
  request: requestSchema,
  intent: intentSchema,
  grant: grantSchema,
  family: familySchema,
  refresh: refreshSchema,
  access: accessSchema,
  code: codeSchema,
  ticket: ticketSchema,
  tombstone: tombstoneSchema,
  event: eventSchema,
  quota: quotaSchema,
  policy: z.object({
    kind: z.enum(['redirect', 'cors']),
    revision: z.number().int().nonnegative(),
    origins: z.array(z.string()),
  }),
  decision: z.object({
    id: z.string(),
    fingerprint: z.string(),
    actionDigest: digest,
    actor: actorSchema,
    effect: z.record(z.string(), z.unknown()),
    createdAt: timestamp,
  }),
};
export type Records = {
  [K in keyof typeof recordSchemas]: z.infer<(typeof recordSchemas)[K]>;
};
export type RegistrationMetadata = z.infer<typeof metadataSchema>;
export type GrantSelection = z.infer<typeof selectionSchema>;
export type Supersession = z.infer<typeof supersessionSchema>;

export class OutsideOAuthRefusal extends Error {
  constructor(
    readonly code:
      | 'invalid_grant'
      | 'invalid_client'
      | 'invalid_request'
      | 'invalid_target'
      | 'invalid_scope'
      | 'capacity'
      | 'target_changed'
      | 'audit_capacity',
  ) {
    super(
      code === 'audit_capacity'
        ? 'audit_capacity: OAuth audit is full; drain delivery or retention before starting new OAuth state. Revocation remains available.'
        : code === 'invalid_grant'
          ? 'invalid_grant: sign in again with a new review'
          : code,
    );
  }
}
