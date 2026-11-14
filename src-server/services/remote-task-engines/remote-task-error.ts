/**
 * The one error every remote task engine path throws. `code` and `status` are
 * what a route answers; `message` is authored by Station or is a vendor's
 * own error text after {@link redactSecret} removed the connection's token.
 */
import type { RemoteTaskRefusalCode } from '@kontourai/station-contracts/remote-task-engine';

export class RemoteTaskError extends Error {
  constructor(
    readonly code: RemoteTaskRefusalCode,
    message: string,
    readonly status: number,
    readonly details: {
      readonly retryAfterMs?: number;
      /** The vendor's HTTP status, for a vendor refusal. */
      readonly vendorStatus?: number;
      /** The vendor's own error code, when it sends one. */
      readonly vendorCode?: string;
    } = {},
  ) {
    super(message);
    this.name = 'RemoteTaskError';
  }
}

/** The longest vendor error text Station passes on. */
const VENDOR_MESSAGE_MAX_CHARS = 500;

/**
 * Removes `secret` from `text` wherever it appears and bounds its length, so
 * a vendor that echoes the request's credential in an error cannot pass it
 * on through Station.
 */
export function redactSecret(text: string, secret: string | undefined): string {
  let out = text;
  if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  return out.length > VENDOR_MESSAGE_MAX_CHARS
    ? `${out.slice(0, VENDOR_MESSAGE_MAX_CHARS)}…`
    : out;
}
