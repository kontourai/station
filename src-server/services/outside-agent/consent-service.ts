// UNWIRED(#4115): passkey decisions are composed only by isolated tests until R6.
import { randomBytes } from 'node:crypto';
import type { RuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import type { ConsentChannelService } from '../consent/consent-channel.js';
import {
  ConsentCommitRefusedError,
  type ConsentDescription,
} from '../consent/consent-transactions.js';
import { outsideAgentConsentTarget } from './consent-targets.js';
import type {
  OutsideAgentManagementService,
  OutsideDecisionActor,
  OutsideManagementReview,
} from './management-service.js';
import { OutsideOAuthRefusal } from './oauth-records.js';

type Session = NonNullable<
  RuntimeAuthenticatedRequestPrincipal['operatorSession']
>;

function description(
  review: OutsideManagementReview,
  service: OutsideAgentManagementService,
  actor: OutsideDecisionActor,
): ConsentDescription {
  const target = review.target;
  const action = review.action;
  const title =
    action.operation === 'approve'
      ? 'Approve outside client'
      : action.operation === 'deny'
        ? 'Deny outside client request'
        : action.operation === 'revoke'
          ? 'Revoke outside client grant'
          : action.operation === 'change'
            ? 'Change outside client access'
            : action.operation === 'origin'
              ? `${action.action === 'add' ? 'Add' : 'Remove'} ${action.policy === 'redirect' ? 'redirect' : 'CORS'} origin`
              : 'Review outside client';
  const items = [{ label: 'Station resource', detail: target.resource }];
  if (review.clientDetails)
    items.push(
      {
        label: 'Client name (unverified)',
        detail: review.clientDetails.clientName || '(unnamed)',
      },
      {
        label: 'Client ID — not proof of identity',
        detail: review.clientDetails.clientId,
      },
    );
  if ('redirectUri' in target)
    items.push({
      label:
        new URL(target.redirectUri).protocol === 'https:'
          ? 'Exact redirect URI (remote site)'
          : 'Exact redirect URI',
      detail: target.redirectUri,
    });
  if ('requestId' in target)
    items.push(
      { label: 'Request', detail: target.requestId },
      { label: 'Requested scopes', detail: target.requestedScopes.join(', ') },
    );
  if ('grantId' in target) {
    const before = service
      .list(actor)
      .grants.find((g) => g.grantId === target.grantId);
    if (!before) throw new OutsideOAuthRefusal('target_changed');
    items.push(
      { label: 'Grant', detail: target.grantId },
      {
        label: 'Before',
        detail: `${before.accessLevel}; expires ${new Date(before.expiresAt).toISOString()}`,
      },
      ...service.projectScopeDescription(before.projectScope).map((item) => ({
        ...item,
        label: `Before ${item.label}`,
      })),
      { label: 'Requested scopes', detail: target.requestedScopes.join(', ') },
    );
  }
  if ('selectedAccessLevel' in target && target.selectedAccessLevel)
    items.push(
      {
        label:
          action.operation === 'revoke'
            ? 'Access being revoked'
            : 'Selected access',
        detail: `${target.selectedAccessLevel}; ${target.selectedScopes.join(', ')}`,
      },
      ...service.projectScopeDescription(target.projectScope!),
      {
        label: 'Expiry (UTC)',
        detail: new Date(target.expiresAt!).toISOString(),
      },
    );
  if ('canonicalOrigin' in target)
    items.push(
      {
        label: 'Canonical HTTPS origin',
        detail: target.canonicalOrigin.serializedOrigin,
      },
      {
        label: 'Policy revision',
        detail: String(target.expectedPolicyRevision),
      },
      {
        label: 'Effect',
        detail:
          action.operation === 'origin' && action.action === 'remove'
            ? action.policy === 'redirect'
              ? 'Cancel affected requests and revoke affected grants.'
              : 'Refuse this browser Origin and disconnect its browser sessions. Native grants remain independently authorized.'
            : 'Permit this exact origin only. This does not approve a client.',
      },
    );
  for (const candidate of review.supersessionCandidates)
    items.push({
      label: candidate.selected
        ? 'Selected supersession — this will disconnect'
        : 'Unselected matching grant (unverified match)',
      detail: `${candidate.name} / ${candidate.clientId}; grant ${candidate.grantId}; ${candidate.redirectUri}; ${candidate.accessLevel}; last use ${candidate.lastUsedAt === null ? 'never' : new Date(candidate.lastUsedAt).toISOString()}; expires ${new Date(candidate.expiresAt).toISOString()}. ${candidate.selected ? 'This will disconnect this installation when the new login completes.' : 'This installation will keep its access.'}`,
    });
  const warnings = [
    review.warning ??
      ('redirectUri' in target &&
      new URL(target.redirectUri).protocol === 'https:'
        ? `Sends access to ${new URL(target.redirectUri).origin}, a remote site.`
        : null),
    action.operation === 'approve'
      ? 'Approval records intent only. Access and selected disconnections take effect when the client completes sign-in. Changing the selection requires a new review.'
      : null,
  ].filter((warning): warning is string => Boolean(warning));
  return {
    title,
    summary:
      'Review this exact action. Client names and client IDs do not prove the identity of the requesting software or installation.',
    items,
    warnings,
    ...('requestId' in target
      ? {
          comparisonCode:
            review.comparisonCode ?? 'Unavailable — open a new login request.',
        }
      : {}),
    approveLabel:
      action.operation === 'deny'
        ? 'Deny request with passkey'
        : 'Confirm with passkey',
    denyLabel: 'Cancel review',
  };
}

export class OutsideAgentConsentService {
  constructor(
    readonly management: OutsideAgentManagementService,
    readonly channel: ConsentChannelService,
    /** Resolve live delegator and authority revision from server state, never from the request body. */
    readonly actorFor: (
      session: Session,
      passkeyId: string,
    ) => OutsideDecisionActor & { kind: 'operator-passkey' },
  ) {}

  request(raw: unknown, session: Session) {
    const assertSession = () => {
      if (!session.isCurrent())
        throw new ConsentCommitRefusedError(
          'Your operator session ended; sign in again.',
          false,
          'session_ended',
        );
    };
    assertSession();
    if (
      !this.channel.trustedOrigin ||
      this.channel.state().status !== 'listening'
    )
      throw new OutsideOAuthRefusal('invalid_request');
    const actor = this.actorFor(session, session.passkeyId);
    const reviewed = this.management.review(raw, actor);
    if (reviewed.target.kind === 'outside-agent-registration')
      throw new OutsideOAuthRefusal('invalid_request');
    const target = outsideAgentConsentTarget(reviewed.target);
    // Capture parsed inputs; neither later request mutation nor a client-supplied fingerprint can replace them.
    const action = structuredClone(reviewed.action);
    const decisionId = randomBytes(32).toString('base64url');
    const currentTarget = (passkeyId = session.passkeyId) => {
      assertSession();
      try {
        const current = this.management.review(
          action,
          this.actorFor(session, passkeyId),
        );
        return current.target.kind === 'outside-agent-registration'
          ? null
          : outsideAgentConsentTarget(current.target);
      } catch (error) {
        if (
          error instanceof OutsideOAuthRefusal &&
          error.code === 'target_changed'
        )
          return null;
        throw error;
      }
    };
    return this.channel.store.create({
      tenantId: this.channel.tenantId,
      ceremony: 'webauthn',
      operatorSessionId: session.sessionId,
      target,
      rateKey: session.sessionId,
      requester: { kind: 'operator-session', id: session.sessionId },
      description: description(reviewed, this.management, actor),
      revalidateTarget: async () => currentTarget(),
      commitApproval: async (passkeyId) => {
        assertSession();
        if (
          !passkeyId ||
          currentTarget(passkeyId)?.fingerprint !== target.fingerprint
        )
          throw new ConsentCommitRefusedError(
            'This changed since you asked. Open a new request.',
            false,
            'target_changed',
          );
        try {
          // This synchronous span owns SQLite's mutation lock. There is no await between
          // live session/target checks, domain mutation and the durable decision/outbox.
          return this.management.store.decide(() => {
            assertSession();
            return this.management.commit(
              { action, fingerprint: target.fingerprint, decisionId },
              this.actorFor(session, passkeyId),
            );
          });
        } catch (error) {
          if (
            error instanceof OutsideOAuthRefusal &&
            error.code === 'target_changed'
          )
            throw new ConsentCommitRefusedError(
              'This changed since you asked. Open a new request.',
              false,
              'target_changed',
            );
          throw error;
        }
      },
    });
  }
}
