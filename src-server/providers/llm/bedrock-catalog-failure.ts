/**
 * What an AWS Bedrock catalogue failure actually was (#3654).
 *
 * Every other model provider hands `listModelCatalog` failures to
 * `classifyCatalogFailure`, which reads an HTTP status off the error. AWS SDK
 * v3 errors carry neither `status` nor `statusCode` — they carry a `name`
 * (`AccessDeniedException`, `UnrecognizedClientException`, …) and a
 * `$metadata.httpStatusCode` — so that shared classifier reads every Bedrock
 * failure as `unreachable`, and Bedrock's own catch discarded the error before
 * it could even try. With no `reasonKind`, `recordModelCatalogDiscovery`
 * writes NO receipt at all, which is why a Bedrock connection read
 * "Saved — not verified" no matter what had been observed.
 *
 * The three kinds are the ones the rest of the pipeline already understands:
 * `refused` (recorded as a failed check), `no-catalog` (recorded as
 * catalog-unavailable, and the only kind that lets the explicit test go on to
 * ask the chat route directly), `unreachable` (Station got no answer to
 * judge).
 */

import { redactSecrets } from '@kontourai/station-shared/redaction';
import type { LLMModelCatalog } from './model-provider-types.js';

export type BedrockCatalogFailureKind = NonNullable<
  LLMModelCatalog['reasonKind']
>;

/**
 * An IAM policy may grant `bedrock:InvokeModel` and withhold
 * `bedrock:ListFoundationModels` — a normal, deliberate scoping, not a
 * connection that cannot work. Classifying it as a refusal marks such a
 * connection permanently broken and, worse, stops the explicit test before
 * the one thing that could still prove it: the minimal chat request. So an
 * authorization denial ON THE CATALOGUE is `no-catalog`, exactly like a 404
 * on another provider's `/models` route.
 */
const CATALOG_DENIED_ERROR_NAMES = new Set([
  'AccessDeniedException',
  'AccessDenied',
  'UnauthorizedOperation',
]);

/** The catalogue route itself is not there to answer. */
const NO_CATALOG_ERROR_NAMES = new Set(['ResourceNotFoundException']);

/**
 * The credential itself was turned away, or could not be produced at all.
 * Nothing this connection asks for will work until its settings change, so
 * this is a failed check with a reason — not a catalogue quirk, and not a
 * reachability claim.
 */
const REFUSED_ERROR_NAMES = new Set([
  // Station's own fail-closed auth guard: these settings cannot produce a
  // request, which is a failed check with a fixable reason rather than a
  // statement about whether AWS is reachable.
  'BedrockAuthConfigurationError',
  'UnrecognizedClientException',
  'InvalidSignatureException',
  'InvalidClientTokenId',
  'SignatureDoesNotMatch',
  'IncompleteSignature',
  'MissingAuthenticationTokenException',
  'MissingAuthenticationToken',
  'ExpiredTokenException',
  'ExpiredToken',
  'InvalidAccessKeyId',
  'AuthFailure',
  'UnauthorizedException',
  'CredentialsProviderError',
  'CredentialsError',
]);

/**
 * Station never got an answer it could judge: the request did not arrive, the
 * service declined to serve it right now, or the service itself failed. Every
 * one of these can succeed on the next attempt, which is what the unreachable
 * grace window in the readiness evidence is for.
 */
const UNREACHABLE_ERROR_NAMES = new Set([
  'NetworkingError',
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceUnavailableException',
  'ServiceQuotaExceededException',
  'InternalServerException',
  'InternalFailure',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);

/** A full ARN, which names the account and often the principal. */
const ARN_PATTERN =
  /\barn:[a-z0-9-]*:[a-z0-9*-]*:[a-z0-9-]*:[0-9*]*:[^\s"'`,;]+/gi;
/** A bare 12-digit AWS account id, as `AccessDeniedException` often quotes. */
const ACCOUNT_ID_PATTERN = /\b\d{12}\b/g;

/**
 * Removes the account and principal identity AWS echoes back inside its own
 * error text.
 *
 * `redactConnectionSecretEchoes` — the pass every provider's reason already
 * goes through — can only scrub values that are stored in the connection's
 * own config. An account id and a role ARN are neither: AWS supplies them,
 * this device never held them, and they end up rendered in a connection
 * notice and stored in a check receipt. They are not credentials, but they
 * name the account and the principal, so they do not belong in a readiness
 * string a screenshot or a bug report will carry.
 *
 * The action AWS names (`bedrock:ListFoundationModels`) is deliberately kept:
 * it is the whole diagnostic value of the message, and it identifies nobody.
 */
export function redactAwsIdentifiers(message: string): string {
  return redactSecrets(
    message
      .replace(ARN_PATTERN, (match) => {
        // Keep trailing sentence punctuation the greedy match swallowed.
        const trailing = match.match(/[.,;:)]+$/)?.[0] ?? '';
        return `arn:[redacted]${trailing}`;
      })
      .replace(ACCOUNT_ID_PATTERN, '[redacted]'),
  );
}

function errorName(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const candidate = error as { name?: unknown; code?: unknown };
  if (typeof candidate.name === 'string' && candidate.name) {
    return candidate.name;
  }
  return typeof candidate.code === 'string' ? candidate.code : '';
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const candidate = error as { code?: unknown };
  return typeof candidate.code === 'string' ? candidate.code : '';
}

function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } })
    .$metadata;
  const status = metadata?.httpStatusCode;
  return typeof status === 'number' ? status : undefined;
}

/** Whether this failure is the catalogue call being denied specifically. */
export function isBedrockCatalogAuthorizationDenial(error: unknown): boolean {
  return CATALOG_DENIED_ERROR_NAMES.has(errorName(error));
}

export function classifyBedrockCatalogFailure(
  error: unknown,
): BedrockCatalogFailureKind {
  const name = errorName(error);
  const code = errorCode(error);
  // The NAME decides first, and only then the status: a 403 is
  // `AccessDeniedException` (this policy does not list models) and
  // `UnrecognizedClientException` (this credential is not valid) alike, and
  // those two mean opposite things to a user.
  if (CATALOG_DENIED_ERROR_NAMES.has(name)) return 'no-catalog';
  if (NO_CATALOG_ERROR_NAMES.has(name)) return 'no-catalog';
  if (REFUSED_ERROR_NAMES.has(name)) return 'refused';
  if (UNREACHABLE_ERROR_NAMES.has(name) || UNREACHABLE_ERROR_NAMES.has(code)) {
    return 'unreachable';
  }
  const status = httpStatus(error);
  if (status !== undefined) {
    if (status === 404 || status === 405 || status === 501) return 'no-catalog';
    if (status === 408 || status === 429 || status >= 500) return 'unreachable';
    if (status >= 400) return 'refused';
  }
  // An unnamed, statusless failure is Station's own guard tripping (a
  // pagination token that did not advance, a page limit) or a transport that
  // never produced a response. Neither is an observation of what AWS thinks
  // of these settings, so it must not read as a refusal.
  return 'unreachable';
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return '';
}

/**
 * The classified reason a Bedrock catalogue request failed, redacted, in the
 * shape `LLMModelCatalog` carries and `recordModelCatalogDiscovery` requires.
 */
export function describeBedrockCatalogFailure(error: unknown): {
  reason: string;
  reasonKind: BedrockCatalogFailureKind;
} {
  const reasonKind = classifyBedrockCatalogFailure(error);
  const message = redactAwsIdentifiers(errorText(error)).trim();
  if (isBedrockCatalogAuthorizationDenial(error)) {
    return {
      reasonKind,
      reason:
        `${message} These credentials are not allowed to list Bedrock models, which says nothing about whether they can invoke one.`.trim(),
    };
  }
  return {
    reasonKind,
    reason:
      message ||
      'Station could not complete a Bedrock model-catalog request with these settings.',
  };
}
