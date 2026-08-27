import type {
  AnswerShareMintResult,
  AnswerShareSummary,
} from '@kontourai/station-contracts/answer-share';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import { authenticatedFetch } from '../client/http';
import type { QueryConfig } from '../query-core';

/**
 * Answer-share management (station#1423) — the OPERATOR's side only.
 *
 * `/api/shares` is `access:manage`-gated (`pairing-route-scopes.ts`), the same
 * tier as `/api/pairing`, so a browser reaching this Station over the network
 * without an operator-tier credential gets a 403. Callers treat that as "hide
 * the section", never a hard error — the same posture
 * `usePeerCredentialsQuery` documents.
 *
 * There is deliberately NO hook here for reading a share. A share is read by
 * its holder, who has no SDK, no credential, and no query client — they POST
 * a token to the public view route from the standalone permalink view.
 */

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * **401 only** — the caller presented no credential at all, so this browser
 * has never been paired with this Station.
 *
 * station#1423 H-1 put `POST`/`DELETE /api/shares` behind a presented
 * credential, so an unenrolled browser now gets a 401 from the middleware —
 * before the route runs, with the middleware's own `{ error: { code } }` body
 * rather than the route's `{ success, error }` envelope. Distinguished as its
 * own type so the UI can name the prerequisite instead of rendering
 * `[object Object]`, which is what the generic path produced.
 *
 * Deliberately NOT raised for 403 (security review N-3). A 403 means a
 * credential WAS presented and was refused — an underscoped device
 * (`insufficient_scope`), or a cross-origin/originless mutation
 * (`origin_forbidden`/`origin_required`). Telling those callers to "pair this
 * browser" is false and sends them to re-do something already done; pairing
 * again would not grant a paired device `access:manage` either, because no
 * preset carries it.
 */
export class AnswerShareAuthRequiredError extends Error {
  readonly status = 401;
  constructor() {
    super(
      'This browser is not paired with Station yet, and sharing an answer needs it to be.',
    );
    this.name = 'AnswerShareAuthRequiredError';
  }
}

/**
 * **403** — a credential was presented and refused. Carries the boundary's
 * own reason code so the UI can say which refusal happened rather than
 * collapsing two different problems into one wrong instruction (N-3).
 */
export class AnswerShareForbiddenError extends Error {
  readonly status = 403;
  readonly code: string | undefined;
  constructor(code: string | undefined) {
    super(
      code === 'insufficient_scope'
        ? 'This device is paired, but its access level does not allow managing shares. Only a credential with device-management access can publish or revoke answer links.'
        : code === 'origin_required' || code === 'origin_forbidden'
          ? 'Station refused this request because of where it came from. Open Station on its own address rather than through an embed or a redirect.'
          : 'Station refused this request.',
    );
    this.name = 'AnswerShareForbiddenError';
    this.code = code;
  }
}

/** The boundary's `{ error: { code } }` body, when that is what came back. */
async function boundaryCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    const code = body?.error?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

async function unwrap<T>(response: Response, defaultError: string): Promise<T> {
  if (response.status === 401) throw new AnswerShareAuthRequiredError();
  if (response.status === 403) {
    throw new AnswerShareForbiddenError(await boundaryCode(response));
  }
  let result: ApiEnvelope<T>;
  try {
    result = (await response.json()) as ApiEnvelope<T>;
  } catch {
    // A non-JSON body (a proxy error page, a truncated response) must not
    // surface as a parse exception with no bearing on what happened.
    throw new Error(defaultError);
  }
  if (!response.ok || !result.success || result.data === undefined) {
    // `result.error` is a string on this route's own envelope; anything else
    // is not ours to render verbatim.
    throw new Error(
      typeof result.error === 'string' && result.error
        ? result.error
        : defaultError,
    );
  }
  return result.data;
}

export function fetchAnswerShares(): Promise<AnswerShareSummary[]> {
  return (async () => {
    const apiBase = await _getApiBase();
    const response = await authenticatedFetch(`${apiBase}/api/shares`);
    return unwrap<AnswerShareSummary[]>(
      response,
      'Answer shares request failed',
    );
  })();
}

const ANSWER_SHARES_QUERY_KEY = ['answer-shares'] as const;

export const answerShareQueries = {
  list: () => ({
    queryKey: ANSWER_SHARES_QUERY_KEY,
    queryFn: fetchAnswerShares,
    staleTime: 30_000,
    retry: false,
  }),
};

export function useAnswerSharesQuery(
  config?: QueryConfig<AnswerShareSummary[]>,
) {
  return useQuery({ ...answerShareQueries.list(), ...config });
}

export interface MintAnswerShareInput {
  sessionId: string;
  turnId: string;
  label?: string;
  ttlMs?: number;
}

/**
 * `POST /api/shares`. The response's `token`/`permalink` exist only in this
 * one result — the server keeps a digest — so a caller that discards them
 * without showing them has silently created an unreachable share.
 */
export function useMintAnswerShareMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: MintAnswerShareInput,
    ): Promise<AnswerShareMintResult> => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(`${apiBase}/api/shares`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      return unwrap<AnswerShareMintResult>(
        response,
        'Answer share could not be created',
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ANSWER_SHARES_QUERY_KEY });
    },
  });
}

/** `DELETE /api/shares/:id`. Tombstones the share; the record stays listed. */
export function useRevokeAnswerShareMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (shareId: string): Promise<AnswerShareSummary> => {
      const apiBase = await _getApiBase();
      const response = await authenticatedFetch(
        `${apiBase}/api/shares/${encodeURIComponent(shareId)}`,
        { method: 'DELETE' },
      );
      return unwrap<AnswerShareSummary>(
        response,
        'Answer share could not be revoked',
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ANSWER_SHARES_QUERY_KEY });
    },
  });
}
