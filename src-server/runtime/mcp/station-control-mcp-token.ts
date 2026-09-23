/**
 * archive#1195 (epic archive#1191 slice C): the wire-safe credential for delivering
 * the built-in `station-control` MCP server to an EXTERNAL, less-trusted
 * engine that manages its own outbound MCP connections (Codex's
 * `codex app-server` — see `DeliveryChannel`'s `'wire'` doc comment in
 * `packages/contracts/src/engine-capability-matrix.ts`). Env can never cross
 * that boundary (`withStationControlRuntimeEnv`'s single global
 * `INTERNAL_API_TOKEN` is a subprocess-only mechanism — see
 * `station-control-runtime-env.ts`), so this module mints a SEPARATE,
 * per-session, station-control-scoped bearer token — revoked eagerly on
 * session stop, and otherwise bounded by `DEFAULT_TTL_MS` below (12 hours)
 * — presented to the station-control HTTP/SSE MCP endpoint instead.
 *
 * "Per-session" bounds the token's LIFETIME, not its AUTHORITY: a live token
 * opens the whole station-control tool surface (`station-control-mcp-route.ts`
 * reads the verified entry's tenant context and does not scope by the
 * minting session id). Inherited from archive#1195 and unchanged here.
 *
 * ONE token, TWO delivery channels — the same credential, differing only in
 * where the engine is willing to carry it (`station-control-mcp-route.ts`
 * accepts either):
 *
 *  - Query string (`buildStationControlMcpUrl`) — Codex (archive#1195). Its
 *    `-c mcp_servers.<id>.url=` override is a spawn-time argv, not a payload
 *    the app-server stores or forwards, and codex config has no header
 *    channel; the URL is the only field available.
 *  - `Authorization: Bearer` header (`buildStationControlMcpHeaderUrl` +
 *    `acp-mcp-passthrough.ts`) — ACP (archive#1684). An ACP `session/new`
 *    payload IS handed to the external agent app, so the credential goes in
 *    the field ACP designates for MCP credentials (`McpServerHttp.headers`)
 *    and the URL is built with no token in it at all.
 *
 * This is a DISTINCT trust boundary from `INTERNAL_API_TOKEN`: a valid
 * token here only proves "the caller may open the station-control MCP
 * endpoint for this session" — it grants no direct access to Station's REST
 * API. The station-control tool implementations still authenticate to
 * Station's own API with the existing `INTERNAL_API_TOKEN` mechanism,
 * unchanged (see `station-control-shared.ts`).
 *
 * In-memory only (a module-level Map, not persisted): every minted token is
 * gone on process restart, matching `INTERNAL_API_TOKEN`'s own posture.
 * Tokens are stored as SHA-256 digests, never as plaintext, and verified
 * with `timingSafeEqual` against every live digest (mirrors
 * `isTrustedInternalApiToken`'s reviewed pattern, generalized from one
 * global secret to N per-session ones — the set of concurrently-live
 * sessions is small, so a linear scan is not a performance concern).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import { stationControlMcpTokenMinted } from '../../telemetry/metrics.js';

export const STATION_CONTROL_MCP_PATH = '/mcp/station-control';

/** Default lifetime — 12 hours: generous enough for a long-running Codex or
 * ACP session, but bounded. The token is revoked eagerly on ordinary session
 * stop (`CodexAdapter.stopSession`, `AcpAdapter.stopSession`) and on a failed
 * start; this TTL is the fallback for a session that never cleanly stops
 * (crash, forced kill).
 *
 * Exported (archive#1684 review fix) so the bound is assertable: an injected
 * 100-year default was invisible to every test, because the only production
 * caller passes `undefined` here and nothing observed the resulting
 * `expiresAt`. */
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Which delivery channel a mint is for (archive#1684). Required, not
 * defaulted: the two channels have different exposure — a URL query string
 * the engine holds (Codex) versus an `Authorization` header on an ACP
 * `session/new` payload — and a default would silently attribute one
 * channel's mints to the other on the one metric that can tell them apart.
 */
export type StationControlMcpTokenChannel =
  | 'url-token'
  | 'http-header-token'
  | 'stdio-env-token'
  | 'sdk-in-process';

/**
 * Station #90 lane D: how much a token's presentation says about WHO
 * presented it, derived from the channel it was minted for (recorded on the
 * entry at mint, never supplied by the presenter).
 *
 * - `bound`: `sdk-in-process` only. The token never leaves Station's own
 *   process (Claude's in-process station-control server), so presenting it
 *   proves the call came through that session's MCP connection.
 * - `delegated-custody`: `http-header-token`. Station hands the token to an
 *   ACP agent app in `session/new` over a private pipe, but what the app does
 *   with it next is the app's business: a third-party agent may write it to
 *   its own config, argv or logs. Station cannot prove it stayed private.
 * - `bearer-exposed`: the token sits in a spawned process's argv or env.
 *   `url-token` is in Codex's `-c mcp_servers…url=` argv; `stdio-env-token`
 *   is in a stdio child's env, which the Claude CLI copies into its own
 *   `--mcp-config` argv. Any same-user process can read it with `ps`, so
 *   presenting it proves possession, not session identity.
 *
 * Only `bound` may gate an action that must be attributable to the session
 * (a session-scoped browser tool, an owned child session).
 */
export type StationControlCallerAssurance =
  | 'bound'
  | 'delegated-custody'
  | 'bearer-exposed';

export function stationControlTokenAssurance(
  channel: StationControlMcpTokenChannel,
): StationControlCallerAssurance {
  switch (channel) {
    case 'sdk-in-process':
      return 'bound';
    case 'http-header-token':
      return 'delegated-custody';
    case 'url-token':
    case 'stdio-env-token':
      return 'bearer-exposed';
  }
}

/**
 * The channels the `/mcp/station-control` HTTP endpoint accepts. A stdio
 * env token or an in-process token presented there is refused: neither
 * channel ever needs the endpoint, so a presentation there is a copied
 * credential.
 */
export const STATION_CONTROL_MCP_HTTP_CHANNELS: readonly StationControlMcpTokenChannel[] =
  ['url-token', 'http-header-token'];

interface StationControlMcpTokenEntry {
  sessionId: string;
  expiresAt: number;
  channel: StationControlMcpTokenChannel;
  tenantExecutionContext?: TenantExecutionContext;
}

const tokensByDigest = new Map<string, StationControlMcpTokenEntry>();
// Reverse index so `revokeStationControlMcpToken` doesn't need to scan every
// live entry — a session only ever holds one live token at a time (each
// mint call below deletes the session's prior entry first).
const digestBySession = new Map<string, string>();

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface MintedStationControlMcpToken {
  token: string;
  expiresAt: number;
}

/**
 * Mint a fresh token scoped to `sessionId` (Station's `threadId`), replacing
 * any prior token that session already held (a session that restarts its
 * codex process — e.g. a resume — gets a fresh credential, and the stale one
 * stops working immediately rather than lingering as a second live token).
 */
export function mintStationControlMcpToken(
  sessionId: string,
  channel: StationControlMcpTokenChannel,
  ttlMs: number = DEFAULT_TTL_MS,
  tenantExecutionContext?: TenantExecutionContext,
): MintedStationControlMcpToken {
  const replacedLiveToken = digestBySession.has(sessionId);
  revokeStationControlMcpToken(sessionId);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + ttlMs;
  const tokenDigest = digest(token);
  tokensByDigest.set(tokenDigest, {
    sessionId,
    expiresAt,
    channel,
    ...(tenantExecutionContext ? { tenantExecutionContext } : {}),
  });
  digestBySession.set(sessionId, tokenDigest);
  // Review fix (archive#1195 round 1, LOW): previously declared but never
  // incremented — wired at the single mint choke point (every caller goes
  // through this function) rather than at each call site. `channel`
  // (archive#1684) is what makes a grant observable per delivery path: the
  // refusal already was (`agentCapabilityUndelivered`), but with one
  // undifferentiated mint counter an ACP grant and a Codex grant were the
  // same datum.
  stationControlMcpTokenMinted.add(1, {
    replaced_live_token: String(replacedLiveToken),
    channel,
  });
  return { token, expiresAt };
}

/**
 * Verify a candidate token presented to the station-control MCP HTTP
 * endpoint. Returns the owning `sessionId` when the token is live (found,
 * unexpired); `undefined` for a missing/unknown/expired/malformed
 * candidate — the caller never learns which of those it was (a single
 * generic 401), so this can't be used as a token-guessing oracle.
 */
export function verifyStationControlMcpToken(
  candidate: string | undefined | null,
  options: { channels?: readonly StationControlMcpTokenChannel[] } = {},
):
  | { sessionId: string; tenantExecutionContext?: TenantExecutionContext }
  | undefined {
  const verified = verifyStationControlMcpTokenEntry(candidate);
  if (!verified) return undefined;
  if (options.channels && !options.channels.includes(verified.channel))
    return undefined;
  return {
    sessionId: verified.sessionId,
    ...(verified.tenantExecutionContext
      ? { tenantExecutionContext: verified.tenantExecutionContext }
      : {}),
  };
}

/**
 * As {@link verifyStationControlMcpToken}, plus the channel the token was
 * minted for. Station #90 lane D: the caller derivation reads the channel
 * to report `assurance`.
 */
export function verifyStationControlMcpTokenEntry(
  candidate: string | undefined | null,
):
  | {
      sessionId: string;
      channel: StationControlMcpTokenChannel;
      tenantExecutionContext?: TenantExecutionContext;
    }
  | undefined {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return undefined;
  }
  const candidateDigest = digest(candidate);
  const candidateDigestBuffer = Buffer.from(candidateDigest, 'hex');
  const now = Date.now();
  for (const [storedDigest, entry] of tokensByDigest) {
    const storedDigestBuffer = Buffer.from(storedDigest, 'hex');
    if (
      storedDigestBuffer.length === candidateDigestBuffer.length &&
      timingSafeEqual(storedDigestBuffer, candidateDigestBuffer)
    ) {
      if (entry.expiresAt <= now) {
        tokensByDigest.delete(storedDigest);
        if (digestBySession.get(entry.sessionId) === storedDigest) {
          digestBySession.delete(entry.sessionId);
        }
        return undefined;
      }
      return {
        sessionId: entry.sessionId,
        channel: entry.channel,
        ...(entry.tenantExecutionContext
          ? { tenantExecutionContext: entry.tenantExecutionContext }
          : {}),
      };
    }
  }
  return undefined;
}

/** Best-effort cleanup on ordinary session stop. Never throws. */
export function revokeStationControlMcpToken(sessionId: string): void {
  const existingDigest = digestBySession.get(sessionId);
  if (existingDigest) {
    tokensByDigest.delete(existingDigest);
    digestBySession.delete(sessionId);
  }
}

/**
 * The URL a Codex session's `mcp_servers.station-control.url` override
 * points at — Station's own HTTP/SSE MCP endpoint for station-control, on
 * loopback only (Codex always reaches it as a child of THIS Station
 * process, never remotely). `port` must be the instance's actually-bound
 * port (see `stationControlSpawnEnv`'s doc comment for why — never
 * `process.env.PORT`, stale under `PORT=0`/auto-allocate).
 */
export function buildStationControlMcpUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}${STATION_CONTROL_MCP_PATH}?token=${encodeURIComponent(token)}`;
}

/**
 * archive#1684: the header-channel URL — the SAME endpoint as
 * `buildStationControlMcpUrl` above with NO token in the query string,
 * because the credential rides an `Authorization: Bearer` header instead
 * (ACP's designated channel for MCP credentials; see this module's header
 * comment and `acp-mcp-passthrough.ts`). Deliberately takes no token
 * argument: a builder that accepted one could silently be called with the
 * query-string shape on the header channel, putting the credential in both
 * places. `port` must be the instance's actually-bound port, for the same
 * reason `buildStationControlMcpUrl` says so.
 */
export function buildStationControlMcpHeaderUrl(port: number): string {
  return `http://127.0.0.1:${port}${STATION_CONTROL_MCP_PATH}`;
}

/**
 * archive#1684 (review fix): the ACP channel's mint, as ONE named export
 * rather than an inline closure in `runtime-initialize.ts`.
 *
 * The three properties Station's whole station-control-over-ACP security
 * argument inherits from archive#1195 — per-session tokens, eager revocation,
 * a bounded default TTL — were unobservable while this lived inline: every
 * adapter test injects `mintStationControlMcpAuth` as a `vi.fn()`, so a
 * closure caching one token for all sessions, or passing a 100-year TTL, was
 * green everywhere. Exported so a test can exercise the real thing; its
 * revocation counterpart is `revokeStationControlMcpToken` unchanged.
 */
export function mintStationControlMcpHeaderAuth(
  port: number,
  sessionId: string,
  tenantExecutionContext?: TenantExecutionContext,
): { url: string; token: string } {
  const { token } = mintStationControlMcpToken(
    sessionId,
    'http-header-token',
    undefined,
    tenantExecutionContext,
  );
  return { url: buildStationControlMcpHeaderUrl(port), token };
}

/**
 * Station #90 lane D: the stdio channel's mint, for a per-session stdio
 * station-control child. The child gets this token in its spawn env so its
 * REST calls name a session (`STATION_CONTROL_CALLER_TOKEN_ENV`). Same
 * per-session replacement, revocation and TTL as the HTTP channels.
 *
 * It is `bearer-exposed`: a child's env is readable by same-user processes,
 * and the Claude CLI passes it in `--mcp-config` argv. Anyone who copies it
 * can present it as this session, so it must never gate an action that
 * needs `bound` assurance. Production Claude delivery uses the in-process
 * channel instead (`station-control-in-process.ts`); this mint is the
 * fallback when that is not wired.
 */
export function mintStationControlStdioCallerToken(
  sessionId: string,
  tenantExecutionContext?: TenantExecutionContext,
): string {
  return mintStationControlMcpToken(
    sessionId,
    'stdio-env-token',
    undefined,
    tenantExecutionContext,
  ).token;
}

/** Test-only reset so suites don't leak state across test files. */
export function __resetStationControlMcpTokensForTests(): void {
  tokensByDigest.clear();
  digestBySession.clear();
}
