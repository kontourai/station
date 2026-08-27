/**
 * The UI's single clipboard write (station#3341).
 *
 * Seven components had each hand-rolled this and five of them reported a copy
 * that never happened. Two shapes produced it:
 *
 *  - `navigator.clipboard?.writeText(x)` — Station is routinely reached over
 *    plain `http://` from another device, and on a non-secure origin
 *    `navigator.clipboard` does not exist at all. The optional chain then
 *    evaluates to `undefined`, so `void`-ing it no-ops and `await`-ing it
 *    RESOLVES. A `try`/`catch` around that await is not enough: there is
 *    nothing to catch, and the success branch runs.
 *  - an unhandled promise — a permission refusal rejects, and a caller that
 *    never awaited still ran its success branch.
 *
 * `copyToClipboard` therefore resolves `true` only for a `writeText` call that
 * itself resolved: a missing clipboard is `false`, a rejection is `false`, and
 * nothing throws back to the caller. Callers keep their own affordance — a
 * toast, an inline label, an error line — and derive it from this boolean;
 * confirmations (including haptics) belong only on the `true` branch.
 *
 * `packages/connect`'s `DevicePairingPanel` keeps its own copy of this shape on
 * purpose: it is a separately published package and cannot import from
 * `src-ui/`. It already guards the same three cases and tests them.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    // No `navigator` at all: not reachable from a browser, so it is defence
    // rather than a case, and the unit tests below do not cover it (jsdom
    // always provides one). It is here because this module is importable from
    // a non-DOM context and `navigator.clipboard` would throw a ReferenceError
    // there — a `false` is the same answer every other arm gives.
    if (typeof navigator === 'undefined') return false;
    const clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
