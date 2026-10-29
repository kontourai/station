import type {
  TelemetryRequestFailure,
  TelemetryRequestFailureCode,
} from '@kontourai/station-contracts/telemetry-delivery';

export class TelemetryRequestError extends Error {
  constructor(
    readonly code: TelemetryRequestFailureCode,
    readonly httpStatus?: number,
  ) {
    super(httpStatus === undefined ? code : `${code}: HTTP ${httpStatus}`);
  }
}

export function telemetryRequestFailure(
  error: unknown,
  signal?: AbortSignal,
): TelemetryRequestFailure {
  return {
    at: new Date().toISOString(),
    code:
      error instanceof TelemetryRequestError
        ? error.code
        : signal?.aborted
          ? signal.reason === 'timeout'
            ? 'request_timeout'
            : 'request_cancelled'
          : 'request_failed',
    ...(error instanceof TelemetryRequestError && error.httpStatus !== undefined
      ? { httpStatus: error.httpStatus }
      : {}),
  };
}

/** The deadline settles even when a transport does not cooperate with cancellation. */
export function abortableTelemetryOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(
        new TelemetryRequestError(
          signal.reason === 'timeout' ? 'request_timeout' : 'request_cancelled',
        ),
      );
    if (signal.aborted) {
      void operation.catch(() => undefined);
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    void operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Receipts and OTLP probe responses are bounded and never logged as remote content. */
export async function readTelemetryJson(
  response: Response,
  signal: AbortSignal,
  maxBytes = 8192,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new TelemetryRequestError('response_invalid');
  const bytes: number[] = [];
  try {
    for (;;) {
      const { value, done } = await abortableTelemetryOperation(
        reader.read(),
        signal,
      );
      if (done) break;
      if (bytes.length + value.length > maxBytes)
        throw new TelemetryRequestError('response_too_large');
      for (const byte of value) bytes.push(byte);
    }
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)),
      );
    } catch {
      throw new TelemetryRequestError('response_invalid');
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
