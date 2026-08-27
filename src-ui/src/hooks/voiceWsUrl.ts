/**
 * Pure helper deriving the Voice WebSocket URL from the resolved API base,
 * the *real* Voice WS port fetched from the backend, and the current page
 * location — mirrors `TerminalPanel.tsx`'s existing correct pattern
 * (`new URL(apiBase, window.location.href)` for the host + a
 * protocol-derived `ws:`/`wss:` scheme + `fetchTerminalPort`/`fetchVoicePort`
 * for the real port) instead of the old `new URL(apiBase)` (throws for a
 * relative/empty `apiBase`), hardcoded `ws://` (blocked as mixed content
 * under an `https:` page), and `apiBase`-port-plus-2 arithmetic (wrong by
 * default: see below).
 *
 * #198 code review (H2): the voice WS port must be QUERIED from the
 * backend (`GET ${apiBase}/api/system/voice-port`, via
 * `fetchVoicePort` — see `useVoiceSession.ts`), not derived by adding 2 to
 * `apiBase`'s own port. `apiBase`'s port is the UI's same-origin port by
 * default post-#198 (e.g. `--ui-port`), which is independent of and
 * generally different from the server port that Voice's dedicated WS
 * server actually binds at (`serverPort + 2`,
 * `src-server/runtime/runtime-initialize.ts`) — arithmetic on `apiBase`'s
 * port silently computed the wrong port even on a plain local default
 * `station start`, not just under a reverse proxy.
 *
 * #198 known limitation (still not fixed here, and not fixable by this
 * helper alone): Voice's dedicated WS port is a distinct raw `ws` server,
 * not reachable through the UI-server's same-origin reverse proxy (which
 * only forwards HTTP + SSE on the primary API port). Under a single-origin
 * HTTPS reverse proxy that exposes only the UI port and doesn't separately
 * expose the voice port, Voice will not be reachable — this is a
 * pre-existing architecture limitation, not something #198 fixes. See
 * `docs/reference/env-vars.md`.
 */
export function deriveVoiceWsUrl(
  apiBase: string,
  pageHref: string,
  voicePort: number,
): string {
  const base = new URL(apiBase || '/', pageHref);
  const wsProto = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProto}//${base.hostname}:${voicePort}/?agent=station-voice`;
}
