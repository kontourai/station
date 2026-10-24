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
 * Runtime delivery uses ONE token with TWO delivery channels — the same credential, differing only in
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
 * Public external clients use independent lease ids and explicit selected
 * tools/TTL. Their header-only bearers retain delegated-custody assurance;
 * creating or refreshing a runtime credential does not rotate those leases.
 * Session revocation removes both kinds. No provider credential is exported.
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
import {
  isStationControlExternalClientTool,
  type StationControlExternalClientTool,
} from '@kontourai/station-contracts/station-control-external-client';
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import { stationControlMcpTokenMinted } from '../../telemetry/metrics.js';

export const STATION_CONTROL_MCP_PATH = '/mcp/station-control';
export const STATION_KNOWLEDGE_MCP_PATH = '/mcp/station-knowledge';
export type BuiltinStationApiMcpId = 'station-control' | 'station-knowledge';
export type StationMcpCredentialPurpose =
  | BuiltinStationApiMcpId
  | `oauth-proxy:${string}`;

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
 * - `bearer-exposed`: `url-token`. The token sits in Codex's
 *   `-c mcp_servers…url=` argv, which any same-user process can read with
 *   `ps`, so presenting it proves possession, not session identity.
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
      return 'bearer-exposed';
    default: {
      // Fail closed. `undefined` would slip past the policy's
      // `ASSURANCE_RANK[assurance] < REQUIREMENT_RANK[...]` refusal (the
      // comparison is false), so an unknown channel must never yield a
      // value; the caller derivation turns this into "no caller".
      const unknown: never = channel;
      throw new Error(
        `Unknown station-control token channel: ${String(unknown)}`,
      );
    }
  }
}

/**
 * The channels the `/mcp/station-control` HTTP endpoint accepts. An
 * in-process token presented there is refused: that channel never needs the
 * endpoint, so a presentation there is a copied credential.
 */
export const STATION_CONTROL_MCP_HTTP_CHANNELS: readonly StationControlMcpTokenChannel[] =
  ['url-token', 'http-header-token'];

interface StationControlMcpTokenEntry {
  sessionId: string;
  onRevoke?: () => void;
  serverId: StationMcpCredentialPurpose;
  expiresAt: number;
  channel: StationControlMcpTokenChannel;
  tenantExecutionContext?: TenantExecutionContext;
  allowedTools?: readonly string[];
  externalClientLeaseId?: string;
  callerRecordBinding?: string;
  isIssuerCurrent?: () => boolean;
}

const tokensByDigest = new Map<string, StationControlMcpTokenEntry>();
// Reverse index so `revokeStationControlMcpToken` doesn't need to scan every
// live entry. Each session holds one live token per built-in API server.
const digestBySession = new Map<
  string,
  Map<StationMcpCredentialPurpose, string>
>();
const digestByExternalClientLease = new Map<string, string>();

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface MintedStationControlMcpToken {
  token: string;
  expiresAt: number;
}

/**
 * Mint a fresh token scoped to `sessionId` (Station's `threadId`), replacing
 * any prior token for that session and server (a session that restarts its
 * codex process — e.g. a resume — gets a fresh credential, and the stale one
 * stops working immediately rather than lingering as a second live token).
 */
export function mintStationControlMcpToken(
  sessionId: string,
  channel: StationControlMcpTokenChannel,
  ttlMs: number = DEFAULT_TTL_MS,
  tenantExecutionContext?: TenantExecutionContext,
  allowedTools?: readonly string[],
  serverId: StationMcpCredentialPurpose = 'station-control',
  onRevoke?: () => void,
): MintedStationControlMcpToken {
  const replacedLiveToken =
    digestBySession.get(sessionId)?.has(serverId) ?? false;
  revokeRuntimeToken(sessionId, serverId);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + ttlMs;
  const tokenDigest = digest(token);
  tokensByDigest.set(tokenDigest, {
    onRevoke,
    sessionId,
    serverId,
    expiresAt,
    channel,
    ...(allowedTools !== undefined ? { allowedTools: [...allowedTools] } : {}),
    ...(tenantExecutionContext ? { tenantExecutionContext } : {}),
  });
  const sessionDigests = digestBySession.get(sessionId) ?? new Map();
  sessionDigests.set(serverId, tokenDigest);
  digestBySession.set(sessionId, sessionDigests);
  // Runtime and independent-client factories emit the same delivery counter.
  // Callers do not own this classification. `channel`
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
  options: {
    channels?: readonly StationControlMcpTokenChannel[];
    serverId?: StationMcpCredentialPurpose;
  } = {},
):
  | {
      sessionId: string;
      tenantExecutionContext?: TenantExecutionContext;
      allowedTools?: readonly string[];
      externalClientLeaseId?: string;
      callerRecordBinding?: string;
    }
  | undefined {
  const verified = verifyStationControlMcpTokenEntry(candidate);
  if (!verified) return undefined;
  if (
    verified.serverId.startsWith('oauth-proxy:') &&
    options.serverId !== verified.serverId
  )
    return undefined;
  if (options.serverId && verified.serverId !== options.serverId)
    return undefined;
  if (options.channels && !options.channels.includes(verified.channel))
    return undefined;
  return {
    sessionId: verified.sessionId,
    ...(verified.externalClientLeaseId
      ? { externalClientLeaseId: verified.externalClientLeaseId }
      : {}),
    ...(verified.callerRecordBinding
      ? { callerRecordBinding: verified.callerRecordBinding }
      : {}),
    ...(verified.allowedTools !== undefined
      ? { allowedTools: [...verified.allowedTools] }
      : {}),
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
      serverId: StationMcpCredentialPurpose;
      channel: StationControlMcpTokenChannel;
      allowedTools?: readonly string[];
      externalClientLeaseId?: string;
      callerRecordBinding?: string;
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
        removeTokenEntry(storedDigest, entry);
        return undefined;
      }
      if (entry.isIssuerCurrent) {
        try {
          if (!entry.isIssuerCurrent()) return undefined;
        } catch {
          return undefined;
        }
      }
      return {
        sessionId: entry.sessionId,
        serverId: entry.serverId,
        channel: entry.channel,
        ...(entry.externalClientLeaseId
          ? { externalClientLeaseId: entry.externalClientLeaseId }
          : {}),
        ...(entry.callerRecordBinding
          ? { callerRecordBinding: entry.callerRecordBinding }
          : {}),
        ...(entry.allowedTools !== undefined
          ? { allowedTools: [...entry.allowedTools] }
          : {}),
        ...(entry.tenantExecutionContext
          ? { tenantExecutionContext: entry.tenantExecutionContext }
          : {}),
      };
    }
  }
  return undefined;
}

function removeTokenEntry(
  tokenDigest: string,
  entry: StationControlMcpTokenEntry,
) {
  entry.onRevoke?.();
  tokensByDigest.delete(tokenDigest);
  if (entry.externalClientLeaseId) {
    digestByExternalClientLease.delete(entry.externalClientLeaseId);
    return;
  }
  const sessionDigests = digestBySession.get(entry.sessionId);
  if (sessionDigests?.get(entry.serverId) === tokenDigest)
    sessionDigests.delete(entry.serverId);
  if (sessionDigests?.size === 0) digestBySession.delete(entry.sessionId);
}

function revokeRuntimeToken(
  sessionId: string,
  serverId?: StationMcpCredentialPurpose,
): void {
  const sessionDigests = digestBySession.get(sessionId);
  if (!sessionDigests) return;
  for (const [id, tokenDigest] of sessionDigests) {
    if (serverId && id !== serverId) continue;
    const entry = tokensByDigest.get(tokenDigest);
    if (entry) removeTokenEntry(tokenDigest, entry);
  }
}

/** Session shutdown revokes its runtime credentials and independent client leases. */
export function revokeStationControlMcpToken(
  sessionId: string,
  serverId?: StationMcpCredentialPurpose,
): void {
  revokeRuntimeToken(sessionId, serverId);
  for (const [tokenDigest, entry] of tokensByDigest) {
    if (
      entry.externalClientLeaseId &&
      entry.sessionId === sessionId &&
      (!serverId || entry.serverId === serverId)
    )
      removeTokenEntry(tokenDigest, entry);
  }
}

interface StationControlExternalClientLeaseRecord {
  leaseId: string;
  sessionId: string;
  expiresAt: number;
  allowedTools: readonly StationControlExternalClientTool[];
  callerRecordBinding: string;
}

/** Requires a separately authorized, server-recorded caller; never rotates runtime tokens. */
export function mintStationControlExternalClientLease(input: {
  sessionId: string;
  ttlMs: number;
  allowedTools: readonly StationControlExternalClientTool[];
  callerRecordBinding: string;
  isIssuerCurrent: () => boolean;
}): StationControlExternalClientLeaseRecord & { token: string } {
  if (
    !Number.isSafeInteger(input.ttlMs) ||
    input.ttlMs < 60_000 ||
    input.ttlMs > 3_600_000 ||
    !Array.isArray(input.allowedTools) ||
    input.allowedTools.length === 0 ||
    input.allowedTools.some(
      (tool) => typeof tool !== 'string' || !tool.trim(),
    ) ||
    new Set(input.allowedTools).size !== input.allowedTools.length ||
    !/^[a-f0-9]{64}$/.test(input.callerRecordBinding) ||
    typeof input.isIssuerCurrent !== 'function' ||
    !input.isIssuerCurrent() ||
    !input.sessionId
  )
    throw new Error('Invalid external-client lease scope.');
  const now = Date.now();
  for (const [tokenDigest, entry] of tokensByDigest) {
    if (entry.externalClientLeaseId && entry.expiresAt <= now)
      removeTokenEntry(tokenDigest, entry);
  }
  const leaseId = randomBytes(16).toString('hex');
  const token = randomBytes(32).toString('base64url');
  const expiresAt = now + input.ttlMs;
  const tokenDigest = digest(token);
  tokensByDigest.set(tokenDigest, {
    sessionId: input.sessionId,
    serverId: 'station-control',
    expiresAt,
    channel: 'http-header-token',
    allowedTools: [...input.allowedTools],
    externalClientLeaseId: leaseId,
    callerRecordBinding: input.callerRecordBinding,
    isIssuerCurrent: input.isIssuerCurrent,
  });
  digestByExternalClientLease.set(leaseId, tokenDigest);
  stationControlMcpTokenMinted.add(1, {
    replaced_live_token: 'false',
    channel: 'http-header-token',
  });
  return {
    leaseId,
    token,
    expiresAt,
    sessionId: input.sessionId,
    allowedTools: [...input.allowedTools],
    callerRecordBinding: input.callerRecordBinding,
  };
}

/** Metadata only; the plaintext bearer is returned once at issuance. */
export function readStationControlExternalClientLease(
  leaseId: string,
): StationControlExternalClientLeaseRecord | undefined {
  const tokenDigest = digestByExternalClientLease.get(leaseId);
  const entry = tokenDigest ? tokensByDigest.get(tokenDigest) : undefined;
  if (
    !entry ||
    !tokenDigest ||
    !entry.externalClientLeaseId ||
    !entry.callerRecordBinding ||
    !entry.allowedTools?.every(isStationControlExternalClientTool)
  )
    return undefined;
  if (entry.expiresAt <= Date.now()) {
    removeTokenEntry(tokenDigest, entry);
    return undefined;
  }
  return {
    leaseId,
    sessionId: entry.sessionId,
    expiresAt: entry.expiresAt,
    allowedTools: [...entry.allowedTools],
    callerRecordBinding: entry.callerRecordBinding,
  };
}

export function revokeStationControlExternalClientLease(
  leaseId: string,
): boolean {
  const tokenDigest = digestByExternalClientLease.get(leaseId);
  const entry = tokenDigest ? tokensByDigest.get(tokenDigest) : undefined;
  if (!tokenDigest || !entry) return false;
  removeTokenEntry(tokenDigest, entry);
  return true;
}

/**
 * The URL a Codex session's `mcp_servers.station-control.url` override
 * points at — Station's own HTTP/SSE MCP endpoint for station-control, on
 * loopback only (Codex always reaches it as a child of THIS Station
 * process, never remotely). `port` must be the instance's actually-bound
 * port (see `stationControlSpawnEnv`'s doc comment for why — never
 * `process.env.PORT`, stale under `PORT=0`/auto-allocate).
 */
export function buildStationControlMcpUrl(
  port: number,
  token: string,
  serverId: BuiltinStationApiMcpId = 'station-control',
): string {
  const path =
    serverId === 'station-knowledge'
      ? STATION_KNOWLEDGE_MCP_PATH
      : STATION_CONTROL_MCP_PATH;
  return `http://127.0.0.1:${port}${path}?token=${encodeURIComponent(token)}`;
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
export function buildStationControlMcpHeaderUrl(
  port: number,
  serverId: BuiltinStationApiMcpId = 'station-control',
): string {
  const path =
    serverId === 'station-knowledge'
      ? STATION_KNOWLEDGE_MCP_PATH
      : STATION_CONTROL_MCP_PATH;
  return `http://127.0.0.1:${port}${path}`;
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
  serverId: BuiltinStationApiMcpId = 'station-control',
): { url: string; token: string } {
  const { token } = mintStationControlMcpToken(
    sessionId,
    'http-header-token',
    undefined,
    tenantExecutionContext,
    undefined,
    serverId,
  );
  return { url: buildStationControlMcpHeaderUrl(port, serverId), token };
}

/** Test-only reset so suites don't leak state across test files. */
export function __resetStationControlMcpTokensForTests(): void {
  tokensByDigest.clear();
  digestByExternalClientLease.clear();
  digestBySession.clear();
}
