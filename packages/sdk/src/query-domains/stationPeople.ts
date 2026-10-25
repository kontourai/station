import type {
  MintedPersonalAccessToken,
  PersonalAccessToken,
} from '@kontourai/station-contracts/personal-tokens';
import type {
  StationGroup,
  StationPerson,
} from '@kontourai/station-contracts/station-groups';
import { authenticatedFetch } from '../client/http';
import { rethrowDeadline, unlessDeadline } from '../client/request-deadline';
import {
  type QueryConfig,
  resolveApiBase,
  useApiMutation,
  useApiQuery,
} from '../query-core';

/**
 * #3557: Station groups and personal access tokens.
 *
 * Two route families, two callers:
 *
 * - `/api/pairing/people` is the operator's People page. Listing is admitted
 *   for the operator credential and the desktop's local grant; changing a
 *   group and minting or revoking someone's token need the operator
 *   credential itself or an operator passkey session with per-action step-up.
 *   The current refusal status for other callers is tracked in #4109.
 * - `/api/access/tokens` is a person managing their own tokens from a paired
 *   device tied to them. Anything else is `403 person_device_required`, which
 *   a caller treats as "this panel is not for you", never as an error.
 *
 * Both families answer refusals with a machine code, in two body shapes
 * (`{ error: "code" }` from the pairing routes, `{ error: { code } }` from the
 * boundary and the access routes). {@link StationAccessError} carries the
 * status and that code so callers branch on them, never on message text.
 */
export class StationAccessError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(
      code
        ? `Station refused the request: ${code} (HTTP ${status})`
        : `Station refused the request (HTTP ${status})`,
    );
    this.name = 'StationAccessError';
  }
}

/** A pending per-action review; no change has been applied. */
export class StationStepUpRequiredError extends StationAccessError {
  constructor(
    readonly transaction: { id: string; reviewUrl: string; expiresAt: number },
  ) {
    super(202, 'step_up_required');
    this.name = 'StationStepUpRequiredError';
  }
}

async function requireCompletedWrite(response: Response): Promise<Response> {
  if (response.status === 202) {
    const body: unknown = await response.json().catch(
      unlessDeadline(() => {
        throw new Error('Invalid step-up response');
      }),
    );
    const transaction = isObject(body) ? body.transaction : undefined;
    if (
      !isObject(body) ||
      body.status !== 'step_up_required' ||
      !isObject(transaction) ||
      typeof transaction.id !== 'string' ||
      typeof transaction.reviewUrl !== 'string' ||
      typeof transaction.expiresAt !== 'number' ||
      !Number.isFinite(transaction.expiresAt)
    )
      throw new Error('Invalid step-up response');
    throw new StationStepUpRequiredError({
      id: transaction.id,
      reviewUrl: transaction.reviewUrl,
      expiresAt: transaction.expiresAt,
    });
  }
  if (!response.ok) throw await accessError(response);
  return response;
}

/** Detects the current 401 refusal; its credential-clearing effect is tracked in #4109. */
export function isOperatorCredentialRequired(error: unknown): boolean {
  return error instanceof StationAccessError && error.status === 401;
}

/**
 * Whether a READ was refused as not for this caller: no credential (401), a
 * credential these routes are not for (403, e.g. `person_device_required`),
 * or a Station without the routes (404). A surface hides itself for these;
 * any other failure is a real error to show.
 */
export function isStationAccessUnavailable(error: unknown): boolean {
  return (
    error instanceof StationAccessError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

async function accessError(response: Response): Promise<StationAccessError> {
  let code: string | undefined;
  try {
    const body = (await response.json()) as {
      error?: string | { code?: unknown };
    };
    const raw = typeof body.error === 'string' ? body.error : body.error?.code;
    if (typeof raw === 'string') code = raw;
  } catch (error) {
    rethrowDeadline(error);
    // A non-JSON body: the status alone is the signal.
  }
  return new StationAccessError(response.status, code);
}

async function readJson<T>(
  response: Response,
  check: (body: unknown) => body is T,
  what: string,
): Promise<T> {
  if (!response.ok) throw await accessError(response);
  const body = (await response.json()) as unknown;
  if (!check(body)) throw new Error(`${what} response is malformed`);
  return body;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const hasArray =
  <K extends string>(key: K) =>
  <T>(body: unknown): body is Record<K, T[]> =>
    isObject(body) && Array.isArray(body[key]);

const isMinted = (body: unknown): body is MintedPersonalAccessToken =>
  isObject(body) && typeof body.secret === 'string' && isObject(body.token);

/** What a new token is made with; `expiresInDays` omitted never expires. */
export interface PersonalTokenInput {
  name: string;
  scope: string;
  expiresInDays?: number;
}

const json = (method: string, body?: unknown): RequestInit =>
  body === undefined
    ? { method }
    : {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      };

const personPath = (principalId: string) =>
  `/api/pairing/people/${encodeURIComponent(principalId)}`;

/** `GET /api/pairing/people`. */
export async function fetchStationPeople(
  apiBase?: string,
): Promise<StationPerson[]> {
  const base = await resolveApiBase(apiBase);
  const body = await readJson(
    await authenticatedFetch(`${base}/api/pairing/people`),
    hasArray('people')<StationPerson>,
    'People',
  );
  return body.people;
}

/**
 * What a group change did: the person as they now are, and, keyed by device
 * id, each device whose full access the new group no longer allows and was
 * therefore reset.
 */
export interface StationGroupChange {
  person: StationPerson;
  revocations: Record<string, unknown>;
}

/** `PUT /api/pairing/people/:principalId/group`; operator credential only. */
export async function setStationPersonGroup(
  principalId: string,
  group: StationGroup,
  apiBase?: string,
): Promise<StationGroupChange> {
  const base = await resolveApiBase(apiBase);
  const body = await readJson(
    await requireCompletedWrite(
      await authenticatedFetch(
        `${base}${personPath(principalId)}/group`,
        json('PUT', { group }),
      ),
    ),
    (value): value is { person: StationPerson; revocations?: unknown } =>
      isObject(value) && isObject(value.person),
    'Group change',
  );
  return {
    person: body.person,
    revocations: isObject(body.revocations) ? body.revocations : {},
  };
}

/** `POST /api/pairing/people/:principalId/tokens`; operator credential only. */
export async function mintStationPersonToken(
  principalId: string,
  input: PersonalTokenInput,
  apiBase?: string,
): Promise<MintedPersonalAccessToken> {
  const base = await resolveApiBase(apiBase);
  return readJson(
    await requireCompletedWrite(
      await authenticatedFetch(
        `${base}${personPath(principalId)}/tokens`,
        json('POST', input),
      ),
    ),
    isMinted,
    'Token',
  );
}

/** `DELETE /api/pairing/people/:principalId/tokens/:tokenId`. */
export async function revokeStationPersonToken(
  principalId: string,
  tokenId: string,
  apiBase?: string,
): Promise<void> {
  const base = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${base}${personPath(principalId)}/tokens/${encodeURIComponent(tokenId)}`,
    { method: 'DELETE' },
  );
  await requireCompletedWrite(response);
}

/** `GET /api/access/tokens`: the calling person's own tokens. */
export async function fetchOwnAccessTokens(
  apiBase?: string,
): Promise<PersonalAccessToken[]> {
  const base = await resolveApiBase(apiBase);
  const body = await readJson(
    await authenticatedFetch(`${base}/api/access/tokens`),
    hasArray('tokens')<PersonalAccessToken>,
    'Tokens',
  );
  return body.tokens;
}

/** `POST /api/access/tokens`. The secret is in the answer, and only there. */
export async function mintOwnAccessToken(
  input: PersonalTokenInput,
  apiBase?: string,
): Promise<MintedPersonalAccessToken> {
  const base = await resolveApiBase(apiBase);
  return readJson(
    await authenticatedFetch(`${base}/api/access/tokens`, json('POST', input)),
    isMinted,
    'Token',
  );
}

/** `DELETE /api/access/tokens/:tokenId`. */
export async function revokeOwnAccessToken(
  tokenId: string,
  apiBase?: string,
): Promise<void> {
  const base = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${base}/api/access/tokens/${encodeURIComponent(tokenId)}`,
    { method: 'DELETE' },
  );
  if (!response.ok) throw await accessError(response);
}

export const STATION_PEOPLE_QUERY_KEY = ['station-people'] as const;
export const OWN_ACCESS_TOKENS_QUERY_KEY = ['own-access-tokens'] as const;

/** A refusal is deterministic: asking again cannot change who the caller is. */
const noRetryOnRefusal = (failureCount: number, error: unknown) =>
  !(error instanceof StationAccessError) && failureCount < 2;

export function useStationPeopleQuery(
  apiBase?: string,
  config?: QueryConfig<StationPerson[]>,
) {
  return useApiQuery(
    [...STATION_PEOPLE_QUERY_KEY, apiBase ?? 'default'],
    () => fetchStationPeople(apiBase),
    { staleTime: 15_000, retry: noRetryOnRefusal, ...config },
  );
}

export function useSetStationPersonGroupMutation(apiBase?: string) {
  return useApiMutation(
    (input: { principalId: string; group: StationGroup }) =>
      setStationPersonGroup(input.principalId, input.group, apiBase),
    // A group caps devices, so the device list's effective scopes move too.
    { invalidateKeys: [[...STATION_PEOPLE_QUERY_KEY], ['paired-devices']] },
  );
}

/**
 * The answer carries the token's secret. The mutation keeps it while any
 * observer holds the mutation, so a caller must `reset()` the mutation once
 * it has captured the answer; the settled mutation is then evicted at once
 * (zero retention) rather than kept in the mutation cache.
 */
export function useMintStationPersonTokenMutation(apiBase?: string) {
  return useApiMutation(
    (input: { principalId: string } & PersonalTokenInput) => {
      const { principalId, ...token } = input;
      return mintStationPersonToken(principalId, token, apiBase);
    },
    {
      invalidateKeys: [[...STATION_PEOPLE_QUERY_KEY]],
      evictSettledVariables: true,
    },
  );
}

export function useRevokeStationPersonTokenMutation(apiBase?: string) {
  return useApiMutation(
    (input: { principalId: string; tokenId: string }) =>
      revokeStationPersonToken(input.principalId, input.tokenId, apiBase),
    { invalidateKeys: [[...STATION_PEOPLE_QUERY_KEY]] },
  );
}

export function useOwnAccessTokensQuery(
  apiBase?: string,
  config?: QueryConfig<PersonalAccessToken[]>,
) {
  return useApiQuery(
    [...OWN_ACCESS_TOKENS_QUERY_KEY, apiBase ?? 'default'],
    () => fetchOwnAccessTokens(apiBase),
    { staleTime: 15_000, retry: noRetryOnRefusal, ...config },
  );
}

/** See {@link useMintStationPersonTokenMutation}: `reset()` after capturing. */
export function useMintOwnAccessTokenMutation(apiBase?: string) {
  return useApiMutation(
    (input: PersonalTokenInput) => mintOwnAccessToken(input, apiBase),
    {
      invalidateKeys: [[...OWN_ACCESS_TOKENS_QUERY_KEY]],
      evictSettledVariables: true,
    },
  );
}

export function useRevokeOwnAccessTokenMutation(apiBase?: string) {
  return useApiMutation(
    (tokenId: string) => revokeOwnAccessToken(tokenId, apiBase),
    { invalidateKeys: [[...OWN_ACCESS_TOKENS_QUERY_KEY]] },
  );
}
