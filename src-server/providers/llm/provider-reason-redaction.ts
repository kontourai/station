/**
 * One redaction seam per provider kind for every reason a connection check
 * records (#3654 review, H3).
 *
 * The catalogue path redacted AWS identity where it produced the text, which
 * left the OTHER path that quotes a provider's own words — the fallback chat
 * probe — carrying it through unredacted. An `AccessDeniedException` or
 * `ValidationException` from `InvokeModel` names the principal, the
 * assumed-role session, the account and the resource, and the reason it
 * produces is stored in a check receipt and rendered in a connection notice.
 *
 * Redacting per PROVIDER KIND rather than per call site is the point: a
 * derivation that has to be remembered at each place a reason is built is one
 * that will be forgotten at the next place a reason is built.
 */

import { redactAwsIdentifiers } from './bedrock-catalog-failure.js';

/**
 * Strips the identity a provider echoes back inside its own error text.
 *
 * Only AWS needs this today — it is the only provider whose refusals quote an
 * account and a principal. Providers with nothing of the kind pass through
 * unchanged rather than being run through a pattern set that could only ever
 * damage their messages.
 */
export function redactProviderIdentifiers(
  providerType: string,
  reason: string,
): string {
  return providerType === 'bedrock' ? redactAwsIdentifiers(reason) : reason;
}
