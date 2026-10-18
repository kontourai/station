import {
  PROVIDER_FAILURE_KINDS,
  PROVIDER_FAILURE_RETRYABLE,
  type ProviderFailure,
  type ProviderFailureKind,
} from '@kontourai/station-contracts/provider-failure';

export function providerFailure(
  kind: ProviderFailureKind,
  failurePhase: ProviderFailure['failurePhase'] = 'failed',
  retryAfter?: string,
): ProviderFailure {
  return {
    kind,
    retryable: PROVIDER_FAILURE_RETRYABLE[kind],
    failurePhase,
    ...(retryAfter === undefined ? {} : { retryAfter }),
  };
}

/** Unknown engine diagnostics do not imply a retry is safe. */
export function providerFailureForCode(
  code: string | undefined,
): ProviderFailure {
  const kind =
    code === undefined || !Object.hasOwn(PROVIDER_FAILURE_KINDS, code)
      ? undefined
      : (
          PROVIDER_FAILURE_KINDS as Readonly<
            Record<string, ProviderFailureKind>
          >
        )[code];
  return providerFailure(kind ?? 'provider_error');
}

/** A confirmed pre-effect refusal; never use after a possible provider invocation. */
export class ProviderRefusalError extends Error implements ProviderFailure {
  readonly failurePhase = 'refused';
  get retryable(): boolean {
    return PROVIDER_FAILURE_RETRYABLE[this.kind];
  }
  constructor(
    message: string,
    readonly kind: ProviderFailureKind,
  ) {
    super(message);
    this.name = 'ProviderRefusalError';
  }
}
