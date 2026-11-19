import {
  ENGINE_SIGN_IN_REQUIRED_CODE,
  MODEL_NOT_ADVERTISED_CODE,
} from '@kontourai/station-contracts/provider';

export const ACP_TRANSPORT_CLOSED_CODE = 'acp-transport-closed';
export const ACP_TRANSPORT_CLOSED_GUIDANCE =
  'The ACP connection closed during the turn. Check that the engine is running, then continue explicitly. The provider outcome is unknown.';

const ACP_FAILURE_GUIDANCE: Readonly<Record<string, string>> = {
  [ACP_TRANSPORT_CLOSED_CODE]: ACP_TRANSPORT_CLOSED_GUIDANCE,
  [ENGINE_SIGN_IN_REQUIRED_CODE]:
    'The engine requires sign-in. Sign in on the Station hosting the engine, then continue explicitly.',
  [MODEL_NOT_ADVERTISED_CODE]:
    'This engine session did not provide a usable advertisement for the requested model. Check its model list and provider access before continuing.',
};

export function delegatedRuntimeFailureGuidance(
  code: unknown,
): string | undefined {
  return typeof code === 'string' && Object.hasOwn(ACP_FAILURE_GUIDANCE, code)
    ? ACP_FAILURE_GUIDANCE[code]
    : undefined;
}

export const ACP_UNKNOWN_FAILURE_GUIDANCE =
  'The ACP engine failed without a classified cause. Check the engine and selected model. A catalog entry alone does not verify that a turn can run.';

/** Project only failed, turn-bound account-limit facts from native adapters. */
export function nativeUsageLimitReason(event: {
  provider?: unknown;
  turnId?: unknown;
  kind?: unknown;
  failurePhase?: unknown;
  retriable?: unknown;
  details?: unknown;
}): { code: string; detail: string } | undefined {
  if (
    (event.provider !== 'codex' && event.provider !== 'claude') ||
    typeof event.turnId !== 'string' ||
    !event.turnId ||
    event.kind !== 'quota_exhausted' ||
    event.failurePhase !== 'failed' ||
    event.retriable !== false ||
    !event.details ||
    typeof event.details !== 'object'
  )
    return undefined;

  const details = event.details as {
    usageLimit?: unknown;
    scope?: unknown;
    resetAt?: unknown;
  };
  if (details.usageLimit !== true || details.scope !== 'account')
    return undefined;

  const reset = details.resetAt;
  const validReset =
    typeof reset === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(reset) &&
    Number.isFinite(Date.parse(reset)) &&
    new Date(reset).toISOString() === reset
      ? reset
      : undefined;

  return {
    code: 'provider-account-usage-limit',
    detail: validReset
      ? `The provider account reached its usage limit. Provider-reported reset: ${validReset}. Check the account allowance before continuing explicitly.`
      : 'The provider account reached its usage limit. Check the account allowance before continuing explicitly.',
  };
}
