import { randomUUID } from 'node:crypto';
import {
  type SanitizedError,
  sanitizeError,
} from '@kontourai/station-shared/redaction';

const TRANSPORT_FAILURE_MESSAGES = {
  sse: 'The response stream failed.',
  runtimeHttp: 'The request could not be completed.',
  terminalWebSocket: 'The terminal request failed.',
  voiceWebSocket: 'The voice session could not start.',
  voiceTool: 'The requested tool could not be completed.',
} as const;

export type OutwardTransport = keyof typeof TRANSPORT_FAILURE_MESSAGES;

/**
 * Stable public transport text. Provider, engine, command, and filesystem
 * failures must never decide a browser, SSE, or WebSocket error message.
 */
export function outwardTransportError(transport: OutwardTransport): string {
  return TRANSPORT_FAILURE_MESSAGES[transport];
}

/**
 * A client-visible transport failure carries only a fresh correlation id and
 * fixed text. Callers bind the same id to their sanitized diagnostic so an
 * operator can investigate without exposing the cause to a socket peer.
 */
export function outwardTransportFailure(transport: OutwardTransport): {
  correlationId: string;
  message: string;
} {
  return {
    correlationId: randomUUID(),
    message: outwardTransportError(transport),
  };
}

/**
 * The only error shape passed to an internal logger from a transport catch.
 * Foreign thrown values are never coerced because conversion can disclose
 * arbitrary external output or invoke hostile getters.
 */
export function sanitizedTransportError(error: unknown): SanitizedError {
  if (error instanceof Error) return sanitizeError(error);
  return {
    type: 'NonErrorThrow',
    message: 'A non-Error value was thrown.',
  };
}
