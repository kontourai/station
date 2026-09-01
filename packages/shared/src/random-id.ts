/**
 * Correlation-id fallback for `crypto.randomUUID()` (station#1137).
 *
 * `Crypto.randomUUID()` requires a "secure context" per the Web Crypto spec:
 * `https:`, `http://localhost`, and `http://127.0.0.1` qualify; any other
 * plain-`http://` origin does not, and the method is simply absent there —
 * `undefined`, not a throwing stub. Station is reachable over plain HTTP on a
 * non-localhost host BY DESIGN (`0.0.0.0` default bind in
 * `packages/cli/src/commands/lifecycle.ts`, `--allowed-origin` in
 * `packages/cli/src/cli.ts` precisely so non-localhost origins can reach it),
 * so a phone on the LAN, `http://192.168.1.50:3141`, or
 * `http://<host>.local:3141` is an insecure context a real user reaches.
 * Calling `crypto.randomUUID()` unguarded inside a `useRef` initializer or at
 * module scope throws `TypeError: crypto.randomUUID is not a function`
 * during render/import and takes the whole app down; unguarded in an event
 * handler it only breaks that one action.
 *
 * `randomCorrelationId()` is the one place that decides the fallback so
 * nobody hand-rolls a second one (two call sites already had, independently,
 * before this existed — `chatAttachments.ts` and
 * `browserPreviewPaneInstance.ts` — evidence that per-site patching does not
 * converge). It returns a real UUID when `crypto.randomUUID` is available,
 * degrades to `crypto.getRandomValues` (present without a secure context) to
 * build a v4-shaped id, and only falls back to `Math.random` if neither
 * exists at all.
 *
 * THIS IS FOR CORRELATION ONLY — request/operation/turn ids, pane/tab
 * instance ids, idempotency keys used to dedupe a retry. It is NOT
 * cryptographically strong past the `getRandomValues` tier, and the
 * `Math.random` tier is guessable. A call site that needs unguessability (a
 * token, a nonce, a pairing secret, a credential) must NOT use this helper —
 * keep it on `crypto.randomUUID()` directly with a comment stating the
 * secure-context requirement, or fail the operation explicitly when it is
 * unavailable.
 *
 * `scripts/random-uuid-guard.mjs` bans a bare, unguarded `crypto.randomUUID(`
 * across the scope this helper covers so the crash does not come back one
 * call site at a time.
 */

const HEX = '0123456789abcdef';

/** Renders 16 bytes as a v4-shaped UUID string (RFC 4122 §4.4 bits set). */
function uuidFromBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
    if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
  }
  return out;
}

/**
 * A correlation id, real `crypto.randomUUID()` when available and a
 * best-effort v4-shaped fallback when it is not. See module docblock for the
 * security boundary — never use this where unguessability matters.
 */
export function randomCorrelationId(): string {
  const webCrypto: Crypto | undefined = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    webCrypto.getRandomValues(bytes);
    return uuidFromBytes(bytes);
  }
  // Last resort: no Web Crypto API at all. Math.random is not
  // cryptographically strong — fine for a correlation id, never for
  // anything requiring unguessability (see module docblock).
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return uuidFromBytes(bytes);
}
