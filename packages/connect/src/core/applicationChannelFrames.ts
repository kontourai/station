/** Framing over an already authenticated reliable, ordered application channel. */
const APPLICATION_CHANNEL_PROTOCOL = 'station.application-channel/v1';
export const APPLICATION_CHANNEL_CHUNK_BYTES = 16 * 1024;
const APPLICATION_CHANNEL_FRAME_BYTES = 48 * 1024;
const encoder = new TextEncoder();
type ApplicationChannelFrame =
  | {
      type: 'request';
      method: string;
      path: string;
      headers: [string, string][];
      body: string | null;
    }
  | { type: 'response'; status: number; headers: [string, string][] }
  | { type: 'chunk'; bytes: string }
  | { type: 'credit' }
  | { type: 'end' }
  | { type: 'error'; code: 'protocol_invalid' | 'application_failed' };

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).sort().join(',') ===
    ['version', ...keys].sort().join(',')
  );
}
function headers(value: unknown): value is [string, string][] {
  if (!Array.isArray(value) || value.length > 64) return false;
  const seen = new Set<string>();
  let size = 0;
  for (const pair of value) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== 'string' ||
      typeof pair[1] !== 'string' ||
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(pair[0]) ||
      /[\r\n\0]/.test(pair[1]) ||
      seen.has(pair[0])
    )
      return false;
    seen.add(pair[0]);
    size += encoder.encode(pair[0] + pair[1]).byteLength;
  }
  return size <= 16 * 1024;
}
export function encodeApplicationBytes(bytes: Uint8Array): string {
  if (bytes.byteLength > APPLICATION_CHANNEL_CHUNK_BYTES)
    throw new Error('Application chunk exceeds bound');
  return btoa(String.fromCharCode(...bytes));
}
export function decodeApplicationBytes(value: string): Uint8Array {
  if (
    value.length > Math.ceil(APPLICATION_CHANNEL_CHUNK_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error('Application chunk encoding invalid');
  const bytes = Uint8Array.from(atob(value), (character) =>
    character.charCodeAt(0),
  );
  if (
    bytes.byteLength > APPLICATION_CHANNEL_CHUNK_BYTES ||
    encodeApplicationBytes(bytes) !== value
  )
    throw new Error('Application chunk encoding invalid');
  return bytes;
}
export function readApplicationFrame(input: unknown): ApplicationChannelFrame {
  if (
    typeof input !== 'string' ||
    encoder.encode(input).byteLength > APPLICATION_CHANNEL_FRAME_BYTES
  )
    throw new Error('Application frame exceeds bound');
  const value: unknown = JSON.parse(input);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Application frame invalid');
  const frame = value as Record<string, unknown>;
  if (frame.version !== APPLICATION_CHANNEL_PROTOCOL)
    throw new Error('Application protocol incompatible');
  switch (frame.type) {
    case 'request':
      if (
        !exact(frame, ['type', 'method', 'path', 'headers', 'body']) ||
        typeof frame.method !== 'string' ||
        !/^[A-Z]{1,16}$/.test(frame.method) ||
        typeof frame.path !== 'string' ||
        !frame.path.startsWith('/') ||
        frame.path.startsWith('//') ||
        frame.path.length > 8192 ||
        /[\\#\r\n\0]/.test(frame.path) ||
        !headers(frame.headers) ||
        (frame.body !== null && typeof frame.body !== 'string')
      )
        break;
      if (typeof frame.body === 'string') decodeApplicationBytes(frame.body);
      return frame as unknown as ApplicationChannelFrame;
    case 'response':
      if (
        !exact(frame, ['type', 'status', 'headers']) ||
        !Number.isInteger(frame.status) ||
        Number(frame.status) < 200 ||
        Number(frame.status) > 599 ||
        !headers(frame.headers)
      )
        break;
      return frame as unknown as ApplicationChannelFrame;
    case 'chunk':
      if (!exact(frame, ['type', 'bytes']) || typeof frame.bytes !== 'string')
        break;
      if (decodeApplicationBytes(frame.bytes).byteLength === 0) break;
      return frame as unknown as ApplicationChannelFrame;
    case 'credit':
    case 'end':
      if (!exact(frame, ['type'])) break;
      return frame as unknown as ApplicationChannelFrame;
    case 'error':
      if (
        !exact(frame, ['type', 'code']) ||
        !['protocol_invalid', 'application_failed'].includes(String(frame.code))
      )
        break;
      return frame as unknown as ApplicationChannelFrame;
  }
  throw new Error('Application frame invalid');
}
export function writeApplicationFrame(frame: ApplicationChannelFrame): string {
  const encoded = JSON.stringify({
    version: APPLICATION_CHANNEL_PROTOCOL,
    ...frame,
  });
  readApplicationFrame(encoded);
  return encoded;
}
