export type NativeEnrollmentFailureStage =
  | 'begin-preflight'
  | 'route-status'
  | 'route-currentness'
  | 'station-trust'
  | 'recovery'
  | 'peer-open'
  | 'currentness'
  | 'host-prepare'
  | 'application-request'
  | 'application-response'
  | 'host-accept'
  | 'channel-close'
  | 'peer-close';

const SAFE_CODES = new Set([
  'browser_transport_timeout',
  'browser_transport_failed',
  'native_enrollment_request_invalid',
  'native_enrollment_response_missing',
  'native_enrollment_response_too_large',
  'native_enrollment_peer_expired',
  'native_enrollment_peer_refused',
  'native_enrollment_operation_refused',
  'native_enrollment_application_refused',
  'native_enrollment_invalid',
  'native_enrollment_unsupported',
  'native_enrollment_unavailable',
  'native_enrollment_approval_required',
  'native_enrollment_replayed',
  'native_enrollment_busy',
  'operator_required',
  'native_enrollment_route_refused',
  'native_enrollment_saved_connections_ambiguous',
  'stationTrustRequired',
  'native_enrollment_peer_capacity_reached',
  'native_enrollment_peer_invalid',
  'native_enrollment_peer_binding_mismatch',
  'native_enrollment_peer_unavailable',
  'native_enrollment_peer_open_receipt_invalid',
  'native_enrollment_peer_duplicate',
  'native_enrollment_audience_invalid',
  'native_enrollment_trust_unavailable',
  'native_enrollment_binding_retired',
  'native_enrollment_attempt_changed',
  'native_enrollment_transition_retired',
  'native_enrollment_recovery_invalid',
  'native_enrollment_expired',
  'native_enrollment_recovery_required',
  'native_enrollment_operation_pending',
  'staleProfile',
]);

export interface NativeEnrollmentFailureDiagnostic {
  readonly stage: NativeEnrollmentFailureStage;
  readonly code: string;
  readonly httpStatus?: number;
  readonly cleanup?: readonly {
    readonly stage: 'channel-close' | 'peer-close';
    readonly code: string;
  }[];
}

const diagnostics = new WeakMap<Error, NativeEnrollmentFailureDiagnostic>();

function safeCode(cause: unknown): string {
  if (cause instanceof Error && cause.name === 'AbortError') return 'cancelled';
  const code = cause instanceof Error ? cause.message : cause;
  return typeof code === 'string' && SAFE_CODES.has(code) ? code : 'unknown';
}

/** Preserve Error objects; normalize other failures to a safe-code Error. */
export function captureNativeEnrollmentFailure(
  cause: unknown,
  stage: NativeEnrollmentFailureStage,
  httpStatus?: number,
  cleanup?: NativeEnrollmentFailureDiagnostic['cleanup'],
): Error {
  const error = cause instanceof Error ? cause : new Error(safeCode(cause));
  const previous = diagnostics.get(error);
  diagnostics.set(error, {
    stage: previous?.stage ?? stage,
    code: previous?.code ?? safeCode(cause),
    ...(typeof httpStatus === 'number' &&
    Number.isInteger(httpStatus) &&
    httpStatus >= 100 &&
    httpStatus <= 599
      ? { httpStatus }
      : previous?.httpStatus === undefined
        ? {}
        : { httpStatus: previous.httpStatus }),
    ...(cleanup?.length
      ? {
          cleanup: cleanup.slice(0, 2).map((entry) => ({
            stage: entry.stage,
            code: safeCode(entry.code),
          })),
        }
      : previous?.cleanup
        ? { cleanup: previous.cleanup }
        : {}),
  });
  return error;
}

export function nativeEnrollmentFailureDiagnostic(
  cause: unknown,
): NativeEnrollmentFailureDiagnostic | undefined {
  const value = cause instanceof Error ? diagnostics.get(cause) : undefined;
  return value
    ? {
        ...value,
        ...(value.cleanup
          ? {
              cleanup: value.cleanup.slice(0, 2).map((entry) => ({
                stage: entry.stage,
                code: safeCode(entry.code),
              })),
            }
          : {}),
      }
    : undefined;
}

export function nativeEnrollmentCleanupCode(cause: unknown): string {
  return safeCode(cause);
}
