import type { MiddlewareHandler } from 'hono';
import type { ConsentTransactionStore } from '../services/consent/consent-transactions.js';

function isOutsideAgentPath(path: string): boolean {
  return (
    path === '/mcp' ||
    path === '/mcp/' ||
    path === '/oauth' ||
    path.startsWith('/oauth/') ||
    path === '/api/outside-agent' ||
    path.startsWith('/api/outside-agent/') ||
    path === '/.well-known/oauth-authorization-server' ||
    path === '/.well-known/oauth-authorization-server/' ||
    path === '/.well-known/oauth-protected-resource' ||
    path.startsWith('/.well-known/oauth-protected-resource/')
  );
}

/** SUNSET(#4115): remove the compiled refusal only in the reviewed R6 release change. No configuration can enable it. */
export const outsideAgentReleaseGuard: MiddlewareHandler = async (c, next) => {
  // Use Hono's once-decoded routing path. Case and duplicate slashes remain
  // significant, as in its strict router; encoded guarded segments are refused.
  const path = c.req.path;
  const rawPath = new URL(c.req.url).pathname;
  if (
    isOutsideAgentPath(path) ||
    (path !== rawPath && isOutsideAgentPath(rawPath))
  )
    return c.notFound();
  await next();
};

export type ConsentListenerStore = Pick<
  ConsentTransactionStore,
  | 'get'
  | 'allowsDecisionAuthority'
  | 'verifyDecisionSession'
  | 'renderReview'
  | 'decide'
  | 'passkeyChallenge'
>;

/** SUNSET(#4115): hide outside targets until R6 without changing handler refusal order. */
export function outsideAgentConsentStore(
  store: ConsentTransactionStore,
): ConsentListenerStore {
  const hidden = (tenantId: string, id: string) =>
    store.get(tenantId, id)?.target.kind.startsWith('outside-agent-') === true;
  return {
    get: (tenantId, id) =>
      hidden(tenantId, id) ? undefined : store.get(tenantId, id),
    // Unknown IDs have no requester-only policy. Preserve that same admission
    // for hidden IDs; renderReview and decide still refuse them without effects.
    allowsDecisionAuthority: (tenantId, id, authority) =>
      hidden(tenantId, id) ||
      store.allowsDecisionAuthority(tenantId, id, authority),
    verifyDecisionSession: (tenantId, id, candidate) =>
      !hidden(tenantId, id) &&
      store.verifyDecisionSession(tenantId, id, candidate),
    renderReview: (tenantId, id, authority) =>
      hidden(tenantId, id)
        ? { ok: false, reason: 'not_found' }
        : store.renderReview(tenantId, id, authority),
    decide: async (tenantId, id, decision, nonce, via, proof) =>
      hidden(tenantId, id)
        ? { ok: false, reason: 'not_found' }
        : store.decide(tenantId, id, decision, nonce, via, proof),
    passkeyChallenge: (tenantId, id, nonce, sessionId) =>
      hidden(tenantId, id)
        ? null
        : store.passkeyChallenge(tenantId, id, nonce, sessionId),
  };
}
