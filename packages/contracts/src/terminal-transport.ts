import {
  PAIRING_SCOPE_TERMINAL_OBSERVE,
  PAIRING_SCOPE_TERMINAL_OPERATE,
  pairingScopeIncludes,
} from './environment-security.js';

/** Version 1 terminal socket binary frames. Control frames remain JSON. */
export const TERMINAL_SOCKET_PATH = '/api/terminal/socket';
export const TERMINAL_FRAME_HEADER_BYTES = 13;
export const TERMINAL_WINDOW_BYTES = 64 * 1024;
/** Bounds wire overhead and zero-byte sanitized records independently of credit. */
export const TERMINAL_MAX_OUTSTANDING_OUTPUT_FRAMES = 128;
/** A full buffered rendering control must fit in an output credit window. */
export const TERMINAL_MIN_WINDOW_BYTES = 16 * 1024;
export const TERMINAL_INPUT = 1;
export const TERMINAL_OUTPUT = 2;

/**
 * Authenticated HTTP mint for a single-use socket ticket. Every client,
 * including native shells whose bearer stays in the host transport, fetches
 * one over its ordinary authenticated route and presents it in the upgrade.
 */
export const TERMINAL_TICKET_PATH = '/api/terminal/tickets';
/** Lifetime of an unredeemed ticket; redemption is single-use. */
export const TERMINAL_TICKET_TTL_MS = 30_000;
/** Selected subprotocol: the version this socket speaks. */
export const TERMINAL_SOCKET_PROTOCOL = 'station.terminal.v1';
/**
 * Subprotocol prefix carrying the ticket, so it never enters a URL, an
 * access log or a referrer. The server never echoes it back.
 */
export const TERMINAL_TICKET_PROTOCOL_PREFIX = 'station.terminal.ticket.';
/** 32 random bytes, base64url: valid subprotocol token characters. */
export const TERMINAL_TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface TerminalTicket {
  ticket: string;
  expiresAt: number;
}

/**
 * Server-resolved programs a client may ask for by name. The server resolves
 * the executable, arguments and working directory; a request never carries
 * them. `agent` names a configured engine connection and one of its live modes.
 */
export type TerminalLaunchProfile =
  | { kind: 'shell' }
  | { kind: 'agent'; connectionId: string; mode: string };

/** Close codes a client must not retry with the same authority. */
export const TERMINAL_CLOSE = {
  /** The connection outlived its maximum lifetime; reconnect with a new ticket. */
  lifetime: 4000,
  /** Capacity refusal after admission. */
  capacity: 4429,
} as const;

export function encodeTerminalFrame(
  kind: typeof TERMINAL_INPUT | typeof TERMINAL_OUTPUT,
  channel: number,
  seq: number,
  data: Uint8Array,
): Uint8Array {
  if (
    !Number.isInteger(channel) ||
    channel < 1 ||
    channel > 0xffffffff ||
    !Number.isSafeInteger(seq) ||
    seq < 1
  )
    throw new Error('Invalid terminal frame');
  const bytes = new Uint8Array(TERMINAL_FRAME_HEADER_BYTES + data.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, kind);
  view.setUint32(1, channel);
  view.setBigUint64(5, BigInt(seq));
  bytes.set(data, TERMINAL_FRAME_HEADER_BYTES);
  return bytes;
}

export function decodeTerminalFrame(bytes: Uint8Array) {
  if (bytes.byteLength < TERMINAL_FRAME_HEADER_BYTES)
    throw new Error('Invalid terminal frame');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = view.getUint8(0);
  const channel = view.getUint32(1);
  const seq = Number(view.getBigUint64(5));
  if (
    (kind !== TERMINAL_INPUT && kind !== TERMINAL_OUTPUT) ||
    channel === 0 ||
    !Number.isSafeInteger(seq) ||
    seq < 1
  )
    throw new Error('Invalid terminal frame');
  return {
    kind,
    channel,
    seq,
    data: bytes.subarray(TERMINAL_FRAME_HEADER_BYTES),
  };
}

/** Operate includes watching a terminal; observe never includes mutations. */
export function terminalScopeAllows(
  scope: string,
  operation: 'observe' | 'operate',
): boolean {
  return (
    pairingScopeIncludes(scope, PAIRING_SCOPE_TERMINAL_OPERATE) ||
    (operation === 'observe' &&
      pairingScopeIncludes(scope, PAIRING_SCOPE_TERMINAL_OBSERVE))
  );
}
