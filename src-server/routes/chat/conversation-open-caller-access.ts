import type { ConversationOpenCallerAccess } from '@kontourai/station-contracts/orchestration';
import {
  type CurrentRuntimeRequestPrincipalSecurity,
  getRuntimeAuthenticatedRequestPrincipal,
  runtimeRequestPrincipalMayAccessHttpRoute,
} from '../../security/runtime-request-security.js';

/**
 * The two writes a conversation surface offers, evaluated against THIS
 * caller with the same gate ingress applies, for the exact routes the client
 * posts to: a turn into the conversation goes to
 * `POST /api/orchestration/chat/:conversationId/continue`, a new chat to
 * `POST /api/orchestration/chat`. A paired device without the scope those
 * routes need was offered "Start new chat" and "send a message" by a client
 * that could only guess the route table; the answer now comes from the
 * boundary that will refuse it, so the offer cannot drift from the refusal.
 *
 * `undefined` when the request carries no authenticated runtime principal:
 * the gate would answer `false` for a request it never authenticated, which
 * is not the same as "this caller may not", so the field is omitted and the
 * client treats it as unknown.
 */
export function conversationOpenCallerAccess(
  request: Request,
  security: CurrentRuntimeRequestPrincipalSecurity,
  conversationId: string,
): ConversationOpenCallerAccess | undefined {
  if (!getRuntimeAuthenticatedRequestPrincipal(request)) return undefined;
  return {
    continue: runtimeRequestPrincipalMayAccessHttpRoute(request, security, {
      method: 'POST',
      path: `/api/orchestration/chat/${encodeURIComponent(conversationId)}/continue`,
    }),
    startChat: runtimeRequestPrincipalMayAccessHttpRoute(request, security, {
      method: 'POST',
      path: '/api/orchestration/chat',
    }),
  };
}
