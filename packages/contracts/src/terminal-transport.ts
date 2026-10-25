import {
  PAIRING_SCOPE_TERMINAL_OBSERVE,
  PAIRING_SCOPE_TERMINAL_OPERATE,
  pairingScopeIncludes,
} from './environment-security.js';

/** Version 1 terminal socket binary frames. Control frames remain JSON. */
export const TERMINAL_SOCKET_PATH = '/api/terminal/socket';
export const TERMINAL_FRAME_HEADER_BYTES = 13;
export const TERMINAL_WINDOW_BYTES = 64 * 1024;
export const TERMINAL_INPUT = 1;
export const TERMINAL_OUTPUT = 2;

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
