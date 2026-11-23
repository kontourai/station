import { z } from 'zod';
import { envelopeError } from '../client/api-error-message';
import { type ApiRequestScope, getJson, mutateJson } from '../client/http';
import { unlessDeadline } from '../client/request-deadline';
import { useApiMutation, useApiQuery } from '../query-core';

const clientName = z.string().max(256);
const redirectUri = z.string().max(2048);
const timestamp = z.number().int().nonnegative();
const inventory = z.object({
  resource: z.string().url(),
  pending: z
    .array(
      z.object({
        requestId: z.string(),
        clientId: z.string(),
        expectedRequestFingerprint: z.string(),
        state: z.string(),
        clientName,
        redirectUri,
        expiresAt: timestamp,
      }),
    )
    .max(50),
  grants: z
    .array(
      z.object({
        grantId: z.string(),
        clientId: z.string(),
        version: z.number().int().nonnegative(),
        digest: z.string(),
        clientName,
        redirectUri,
        state: z.enum(['active', 'revoked', 'expired']),
        accessLevel: z.enum(['read-only', 'full']),
        projectScope: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('global') }),
          z.object({ kind: z.literal('project'), projectId: z.string() }),
        ]),
        approvedAt: timestamp,
        expiresAt: timestamp,
        lastUsedAt: timestamp.nullable(),
      }),
    )
    .max(100),
});

type OutsideClientsResult =
  | { state: 'available'; data: z.infer<typeof inventory> }
  | { state: 'operator-required'; signInUrl?: string }
  | { state: 'unavailable' };

async function fetchOutsideClients(
  requestScope: ApiRequestScope,
  signal?: AbortSignal,
): Promise<OutsideClientsResult> {
  const { apiBase } = requestScope;
  const response = await getJson(`${apiBase}/api/outside-agent/clients`, {
    requestScope,
    signal,
    maxResponseBytes: 1_048_576,
  });
  if (response.status === 404) return { state: 'unavailable' };
  const body: unknown = await response.json().catch(unlessDeadline(() => null));
  if (response.status === 403) {
    const parsed = z.object({ signInUrl: z.string().url() }).safeParse(body);
    if (!parsed.success) return { state: 'operator-required' };
    const signIn = new URL(parsed.data.signInUrl);
    const app = new URL(apiBase);
    if (
      signIn.protocol !== 'https:' ||
      signIn.hostname !== app.hostname ||
      signIn.origin === app.origin ||
      signIn.pathname !== '/operator/sign-in' ||
      signIn.username ||
      signIn.password ||
      signIn.search ||
      signIn.hash
    )
      return { state: 'operator-required' };
    return { state: 'operator-required', signInUrl: signIn.href };
  }
  if (!response.ok)
    throw envelopeError(response, body, 'Could not load outside clients.');
  const parsed = inventory.safeParse(body);
  if (!parsed.success)
    throw new Error('Outside client inventory response is invalid.');
  return { state: 'available', data: parsed.data };
}

export function useOutsideClientsQuery(requestScope: ApiRequestScope) {
  return useApiQuery(
    ['outside-clients', requestScope.apiBase, requestScope.authorityKey],
    (signal) => fetchOutsideClients(requestScope, signal),
    {
      staleTime: 0,
      gcTime: 0,
      refetchOnMount: 'always',
      retry: false,
      keepPreviousData: false,
      cancelWhenInactive: true,
    },
  );
}

type OutsideClientRequestRef = {
  requestId: string;
  clientId: string;
  expectedRequestFingerprint: string;
};

type OutsideClientGrantRef = {
  grantId: string;
  expectedVersion: number;
  expectedDigest: string;
};

type OutsideClientScopeSelection = {
  project:
    | { kind: 'global' }
    | { kind: 'project'; slug: string; expectedId: string };
  accessLevel: 'read-only';
  expiresAt: number;
};

export type OutsideClientReviewAction =
  | ({ operation: 'deny' } & OutsideClientRequestRef)
  | ({ operation: 'revoke' } & OutsideClientGrantRef)
  | ({
      operation: 'approve';
      supersessions: OutsideClientGrantRef[];
    } & OutsideClientRequestRef &
      OutsideClientScopeSelection)
  | ({ operation: 'change' } & OutsideClientGrantRef &
      OutsideClientScopeSelection);

const reviewResponse = z.object({
  status: z.literal('step_up_required'),
  transaction: z.object({
    id: z.string().min(1),
    reviewUrl: z.string().url(),
    expiresAt: timestamp,
  }),
});

export function useOutsideClientReviewMutation(requestScope: ApiRequestScope) {
  return useApiMutation(async (action: OutsideClientReviewAction) => {
    let path: string;
    switch (action.operation) {
      case 'approve':
        path = `requests/${encodeURIComponent(action.requestId)}/approval`;
        break;
      case 'deny':
        path = `requests/${encodeURIComponent(action.requestId)}/denial`;
        break;
      case 'change':
        path = `grants/${encodeURIComponent(action.grantId)}/change`;
        break;
      case 'revoke':
        path = `grants/${encodeURIComponent(action.grantId)}/revoke`;
        break;
    }
    const { apiBase } = requestScope;
    const response = await mutateJson(
      `${apiBase}/api/outside-agent/${path}`,
      'POST',
      {
        requestScope,
        maxResponseBytes: 64 * 1024,
      },
      { action },
    );
    const body: unknown = await response
      .json()
      .catch(unlessDeadline(() => null));
    if (response.status !== 202)
      throw envelopeError(
        response,
        body,
        'Could not prepare the passkey review.',
      );
    const parsed = reviewResponse.safeParse(body);
    if (!parsed.success) throw new Error('Passkey review response is invalid.');
    const { id, reviewUrl, expiresAt } = parsed.data.transaction;
    const review = new URL(reviewUrl);
    const app = new URL(apiBase);
    if (
      review.protocol !== 'https:' ||
      review.hostname !== app.hostname ||
      review.origin === app.origin ||
      review.pathname !== `/consent/${encodeURIComponent(id)}` ||
      review.username ||
      review.password ||
      review.search ||
      review.hash
    )
      throw new Error('Passkey review URL is invalid.');
    return { reviewUrl: review.href, expiresAt };
  });
}
