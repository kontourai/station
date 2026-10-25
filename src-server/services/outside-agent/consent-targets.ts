// UNWIRED(#4115): typed passkey adapter; isolated composition only until R6.
import type { ConsentTargetSnapshot } from '../consent/consent-transactions.js';
import type { OutsideManagementReview } from './management-service.js';

type RequestTarget = Extract<
  OutsideManagementReview['target'],
  { requestId: string }
>;
type GrantTarget = Extract<
  OutsideManagementReview['target'],
  { grantId: string }
>;
type OriginTarget = Extract<
  OutsideManagementReview['target'],
  { canonicalOrigin: object }
>;
export type OutsideAgentApprovalTarget = RequestTarget & {
  kind: 'outside-agent-approval';
};
export type OutsideAgentDenialTarget = RequestTarget & {
  kind: 'outside-agent-denial';
};
export type OutsideAgentGrantChangeTarget = GrantTarget & {
  kind: 'outside-agent-grant-change';
};
export type OutsideAgentGrantRevocationTarget = GrantTarget & {
  kind: 'outside-agent-grant-revocation';
};
export type OutsideAgentRedirectOriginChangeTarget = OriginTarget & {
  kind: 'outside-agent-redirect-origin-change';
};
export type OutsideAgentCorsOriginChangeTarget = OriginTarget & {
  kind: 'outside-agent-cors-origin-change';
};

type OutsideAgentTarget =
  | OutsideAgentApprovalTarget
  | OutsideAgentDenialTarget
  | OutsideAgentGrantChangeTarget
  | OutsideAgentGrantRevocationTarget
  | OutsideAgentRedirectOriginChangeTarget
  | OutsideAgentCorsOriginChangeTarget;

/** Canonical bytes come from the shared management owner, including its expected-state bindings. */
export function outsideAgentConsentTarget(
  target: OutsideAgentTarget,
): ConsentTargetSnapshot {
  return {
    kind: target.kind,
    subject:
      'requestId' in target
        ? target.requestId
        : 'grantId' in target
          ? target.grantId
          : target.canonicalOrigin.serializedOrigin,
    fingerprint: JSON.stringify(target),
  };
}
