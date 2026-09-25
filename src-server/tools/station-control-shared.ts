import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { AgentDelegationContext } from '@kontourai/station-contracts/agent';
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import { DEFAULT_SERVER_PORT } from '@kontourai/station-shared/ports';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
  outsideStationServerScope,
  stationServerScopeHeaders,
} from '../utils/internal-api-token.js';

let runtimeControlApiBase: string | undefined;
const executionContexts = new AsyncLocalStorage<TenantExecutionContext>();
const callerBindings = new AsyncLocalStorage<{
  binding: string;
  isCurrent: () => boolean;
}>();
// A stdio child has no verified HTTP bearer. Its process is already created
// for one Station connection; this immutable random binding prevents two
// children from sharing a continuation capability. HTTP's verified token hash
// is installed in AsyncLocalStorage and always wins.
const stdioCallerBinding = randomBytes(32).toString('base64url');
export const INTERNAL_CONTROL_CALLER_BINDING_HEADER =
  'x-station-control-caller-binding';
/** Verified MCP transport identity only; never sourced from public tool input. */
export function withStationControlCallerBinding<T>(
  binding: string,
  operation: () => T,
  isCurrent: () => boolean = () => true,
): T {
  return callerBindings.run({ binding, isCurrent }, operation);
}
export function isStationControlCallerCurrent(): boolean {
  try {
    return callerBindings.getStore()?.isCurrent() ?? true;
  } catch {
    return false;
  }
}

/** Per-request carrier for in-process HTTP MCP; never a process-global tenant. */
export function withStationControlExecutionContext<T>(
  context: TenantExecutionContext | undefined,
  operation: () => T,
): T {
  return context === undefined
    ? operation()
    : executionContexts.run(context, operation);
}

/**
 * Station #90 lane D (station #122): the VERIFIED identity of the agent
 * session calling a station-control tool.
 *
 * Nothing here narrows what an existing tool may do; it makes the caller
 * AVAILABLE, derived from a server-minted per-session credential and never
 * from tool input. A `sessionId` (or any identity) in a tool's arguments is
 * not authority and no code path below reads one.
 *
 * `assurance` says how far that credential can be trusted to mean "this
 * session", from the channel it was minted for (`station-control-mcp-token.ts`
 * `stationControlTokenAssurance`): `bound` credentials never leave Station's
 * process; `delegated-custody` ones were handed to a third-party agent app
 * whose handling Station cannot prove; `bearer-exposed` ones sit in a
 * spawned process's argv or env, so a same-user process can copy them.
 * Browser and other session-scoped tools accept only `bound`.
 *
 * Everything else (principal, project, conversation) comes from the server's
 * own records for the credential's session. Tenant context is never part of
 * this shape (`tenancy.ts`: it is never a public payload field); the REST side
 * checks it internally.
 */
export interface StationControlCaller {
  readonly sessionId: string;
  readonly assurance: StationControlCallerAssurance;
  /**
   * The principal the session acts for (D5). Read from the session's
   * ownership record, never from tool input or a request header. Absent when
   * the session acts for no attributable principal; a consumer that needs
   * one must fail closed.
   */
  readonly principal?: StationControlCallerPrincipal;
  /** Station-local project identity (`ProjectConfig.id`); membership keys on it. */
  readonly localProjectId?: string;
  /**
   * Present with `localProjectId`. `session-record`: stamped by Station when
   * the session started. `slug-lookup`: an older session's slug looked up
   * now, which is wrong if the slug was reused; refuse it for authority.
   */
  readonly projectIdSource?: 'session-record' | 'slug-lookup';
  /** Display only. Slugs are local and renameable; never key authority on one. */
  readonly projectSlug?: string;
  readonly conversationId?: string;
}

/**
 * Mirrors `StationControlCallerAssurance` in `station-control-mcp-token.ts`
 * (kept here so the stdio child bundle need not import the token registry).
 * Only `bound` may gate a session-attributable action.
 */
const STATION_CONTROL_CALLER_ASSURANCES = [
  'bound',
  'delegated-custody',
  'bearer-exposed',
] as const;
export type StationControlCallerAssurance =
  (typeof STATION_CONTROL_CALLER_ASSURANCES)[number];

/**
 * How the acting principal was derived (see `SessionActingPrincipal` in
 * `services/orchestration/session-authorization.ts`). Declared once here; the
 * session-authorization module derives its type from this list.
 */
const STATION_CONTROL_CALLER_PRINCIPAL_SOURCES = [
  'session-owner',
  'legacy-personal-owner',
  'ownerless-single-operator',
] as const;
export type StationControlCallerPrincipalSource =
  (typeof STATION_CONTROL_CALLER_PRINCIPAL_SOURCES)[number];

export interface StationControlCallerPrincipal {
  readonly id: string;
  readonly source: StationControlCallerPrincipalSource;
  /**
   * True only for `session-owner`: an owner Station recorded from the
   * authenticated caller that started the session. A legacy alias mapping
   * and the ownerless single-operator mapping name the operator by
   * inference, so they must never grant anything beyond what the session
   * already had; a consumer that elevates (a Project-role check for browser
   * tools) must require this flag.
   */
  readonly elevationEligible: boolean;
}

/** The one derivation of {@link StationControlCallerPrincipal.elevationEligible}. */
export function stationControlCallerPrincipal(
  id: string,
  source: StationControlCallerPrincipalSource,
): StationControlCallerPrincipal {
  return Object.freeze({
    id,
    source,
    elevationEligible: source === 'session-owner',
  });
}

/**
 * The header a station-control tool's REST call carries its caller
 * credential in. The value is the same per-session token the MCP transport
 * verified; Station's REST side re-verifies it
 * (`resolveStationControlCallerForRequest`), so the header is a credential,
 * not a claim.
 */
export const STATION_CONTROL_CALLER_TOKEN_HEADER =
  'x-station-control-caller-token';
/**
 * Marks every REST request Station's own station-control tool code makes
 * (`isAgentOriginatedRequest`). Station's UI and a pooled station-control
 * child both reach the API as the same internal principal, so without this
 * a route cannot tell an agent's tool call from the operator's own client.
 *
 * It is a declaration, not a proof. Its PRESENCE may only restrict (treat
 * the request as an agent's). Its ABSENCE proves nothing: any process that
 * holds the internal token (an agent with a shell can read it from a stdio
 * child's env or argv) can omit it. So it must never gate a human-only
 * action; those need a credential only a human client holds.
 */
export const STATION_CONTROL_ORIGIN_HEADER = 'x-station-control-origin';
export const STATION_CONTROL_ORIGIN_AGENT_TOOL = 'agent-tool';
/** Spawn-env key carrying a stdio child's per-session caller credential. */
export const STATION_CONTROL_CALLER_TOKEN_ENV = 'STATION_CONTROL_CALLER_TOKEN';
/** The REST projection of the verified caller (used by stdio children). */
export const STATION_CONTROL_CALLER_PATH =
  '/api/orchestration/station-control/caller';

export class StationControlCallerRequiredError extends Error {
  readonly code = 'station_control_caller_required' as const;
  constructor() {
    super(
      'This tool requires a verified calling session. The station-control connection for this engine does not carry one.',
    );
    this.name = 'StationControlCallerRequiredError';
  }
}

interface StationControlCallerContext {
  /** The verified transport credential, forwarded to Station's REST API. */
  readonly token: string | undefined;
  /** Re-derives the caller from the server's token registry and records. */
  readonly resolve: () => StationControlCaller | null;
}
const callerContexts = new AsyncLocalStorage<StationControlCallerContext>();

// Installed only by the stdio entry point (`station-control-server.ts`), which
// reads it from its own spawn env. Station's own process never installs one,
// so an in-process tool call outside an HTTP MCP request has no caller rather
// than inheriting whatever the server's environment happens to hold.
let stdioCallerToken: string | undefined;
// Set by the stdio entry point. A stdio child is a station-control tool
// process by definition, so nothing it sends is Station's own server code
// (`serverSelfHeaders`), whatever else this process happens to hold.
let stdioEntryInstalled = false;

/** Verified MCP transport identity only; never sourced from public tool input. */
export function withStationControlCallerContext<T>(
  context: StationControlCallerContext,
  operation: () => T,
): T {
  // A tool call never runs as server code, whatever scope it inherited.
  return outsideStationServerScope(() =>
    callerContexts.run(context, operation),
  );
}

/**
 * Stdio entry point only: adopt the per-session caller credential from the
 * spawn env and remove it from `process.env`, so nothing this child spawns
 * inherits it.
 */
export function installStationControlStdioCallerCredential(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const value = env[STATION_CONTROL_CALLER_TOKEN_ENV];
  delete env[STATION_CONTROL_CALLER_TOKEN_ENV];
  stdioEntryInstalled = true;
  stdioCallerToken =
    typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Test-only reset for the stdio credential. */
export function __resetStationControlStdioCallerCredentialForTests(): void {
  stdioCallerToken = undefined;
  stdioEntryInstalled = false;
}

/**
 * #2377 slice A: the server-self attestation, only inside an explicit server
 * scope (`runAsStationServer`) and never for a station-control tool call (a
 * verified-caller context, or a stdio child). Outside a server scope nothing
 * is sent and the authority guard fails closed. See
 * `INTERNAL_SERVER_SELF_HEADER`.
 */
function serverSelfHeaders(): Record<string, string> {
  if (callerContexts.getStore() || stdioEntryInstalled) return {};
  return stationServerScopeHeaders();
}

function callerCredential(): string | undefined {
  const context = callerContexts.getStore();
  // An HTTP MCP request always decides for itself; it never falls back to a
  // process-level credential.
  if (context) return context.token;
  return stdioCallerToken;
}

function parseCallerProjection(value: unknown): StationControlCaller | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0)
    return null;
  if (
    typeof record.assurance !== 'string' ||
    !(STATION_CONTROL_CALLER_ASSURANCES as readonly string[]).includes(
      record.assurance,
    )
  )
    return null;
  const principal = record.principal as Record<string, unknown> | undefined;
  const source = principal?.source;
  return Object.freeze({
    sessionId: record.sessionId,
    assurance: record.assurance as StationControlCallerAssurance,
    ...(principal &&
    typeof principal.id === 'string' &&
    principal.id.length > 0 &&
    typeof source === 'string' &&
    (STATION_CONTROL_CALLER_PRINCIPAL_SOURCES as readonly string[]).includes(
      source,
    )
      ? {
          // Re-derived locally: a projection cannot assert eligibility.
          principal: stationControlCallerPrincipal(
            principal.id,
            source as StationControlCallerPrincipalSource,
          ),
        }
      : {}),
    ...(typeof record.localProjectId === 'string'
      ? {
          localProjectId: record.localProjectId,
          // Unknown or missing provenance is treated as the weaker source.
          projectIdSource:
            record.projectIdSource === 'session-record'
              ? ('session-record' as const)
              : ('slug-lookup' as const),
        }
      : {}),
    ...(typeof record.projectSlug === 'string'
      ? { projectSlug: record.projectSlug }
      : {}),
    ...(typeof record.conversationId === 'string'
      ? { conversationId: record.conversationId }
      : {}),
  });
}

/**
 * The verified caller of the current station-control tool call, or `null`
 * when this delivery path carries no per-session credential, the credential
 * is revoked or expired, or Station cannot be reached. In-process (HTTP MCP)
 * calls resolve directly against the token registry; a stdio child asks
 * Station's REST projection, which runs the same derivation.
 */
export async function getStationControlCaller(): Promise<StationControlCaller | null> {
  const context = callerContexts.getStore();
  if (context) {
    try {
      return context.resolve();
    } catch {
      return null;
    }
  }
  if (!stdioCallerToken) return null;
  try {
    const body = (await api(STATION_CONTROL_CALLER_PATH)) as {
      caller?: unknown;
    };
    return parseCallerProjection(body?.caller);
  } catch {
    return null;
  }
}

/** Fails closed with {@link StationControlCallerRequiredError}. */
export async function requireStationControlCaller(): Promise<StationControlCaller> {
  const caller = await getStationControlCaller();
  if (!caller) throw new StationControlCallerRequiredError();
  return caller;
}

function executionContextHeaders(): Record<string, string> {
  const context = executionContexts.getStore();
  const callerToken = callerCredential();
  // In-process HTTP requests always prefer their AsyncLocal request context.
  // A spawned stdio station-control child is already one-session/one-tenant
  // and receives that immutable binding in its process environment; retain
  // that separately reviewed delivery path rather than making hosted stdio
  // tools silently lose all tenant authority.
  const tenantId = context?.tenantId ?? process.env.STATION_INTERNAL_TENANT;
  return {
    ...(tenantId ? { 'x-station-internal-tenant': tenantId } : {}),
    ...serverSelfHeaders(),
    [STATION_CONTROL_ORIGIN_HEADER]: STATION_CONTROL_ORIGIN_AGENT_TOOL,
    ...(callerToken
      ? { [STATION_CONTROL_CALLER_TOKEN_HEADER]: callerToken }
      : {}),
    ...((callerBindings.getStore()?.binding ?? stdioCallerBinding)
      ? {
          [INTERNAL_CONTROL_CALLER_BINDING_HEADER]:
            callerBindings.getStore()?.binding ?? stdioCallerBinding,
        }
      : {}),
  };
}

export function setRuntimeControlApiBase(port: number | undefined): void {
  runtimeControlApiBase =
    port === undefined ? undefined : `http://127.0.0.1:${port}`;
}

export function resolveControlApiBase(env: NodeJS.ProcessEnv = process.env) {
  return (
    env.STATION_API_BASE ||
    runtimeControlApiBase ||
    `http://127.0.0.1:${env.STATION_PORT || env.PORT || DEFAULT_SERVER_PORT}`
  );
}

/**
 * archive#1195: resolved fresh on every call, never frozen at module-import
 * time. The spawned-stdio child this module was originally written for
 * always had the correct env set BEFORE the process (and therefore this
 * module) even started, so a one-time-at-import read was byte-identical to
 * a fresh-per-call read there. That stopped holding once archive#1195
 * needed these same tool registrations reachable IN STATION'S OWN
 * long-lived process (the station-control HTTP/SSE MCP endpoint,
 * station-control-mcp-route.ts) — a module-load-time freeze there would
 * capture whatever `process.env` looked like at Station's own startup
 * (which never sets `STATION_PORT`/`STATION_API_BASE` on itself), not this
 * instance's actually-bound port.
 */
export async function api(path: string, opts?: RequestInit) {
  const res = await fetch(`${resolveControlApiBase()}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
      [INTERNAL_PROXY_CALLER_HEADER]: 'local',
      ...executionContextHeaders(),
      ...opts?.headers,
    },
  });
  return res.json() as Promise<any>;
}

export function jsonToolResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * archive#167 iteration-2 (M1): the standard `Authorization`-equivalent request
 * options every `station-control-*-tools.ts` file attaches to its
 * `@kontourai/station-sdk/client` fetcher calls — hoisted here from four
 * byte-identical local copies (`station-control-agent-tools.ts`,
 * `station-control-catalog-tools.ts`, `station-control-operations-tools.ts`,
 * `station-control-platform-tools.ts`).
 */
export function controlRequestOptions() {
  return {
    headers: {
      [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
      [INTERNAL_PROXY_CALLER_HEADER]: 'local',
      ...executionContextHeaders(),
    },
  };
}

/**
 * archive#167 iteration-2 (M1): the standard success/failure envelope adapter every
 * `station-control-*-tools.ts` file uses to reconstruct the server's raw
 * `{success, data?}` / `{success, error}` envelope from a
 * `@kontourai/station-sdk/client` fetcher's throw-on-failure /
 * unwrap-to-`data` contract — hoisted here from four byte-identical local
 * copies (`toAgentEnvelope`, `toCatalogEnvelope`, `toOperationsEnvelope`,
 * `toPlatformEnvelope`). Each call site imports this under its own local
 * alias (`import { toToolEnvelope as toAgentEnvelope, ... }`) to keep the
 * existing call-site names — and this file's own docblock history — intact.
 * The one genuine divergence (`station-control-catalog-tools.ts`'s
 * `install_skill`, whose failure body uses `message` rather than `error`)
 * stays local rather than folding into this shared adapter.
 */
export async function toToolEnvelope<T>(promise: Promise<T>): Promise<
  | { success: true; data: T }
  | {
      success: false;
      error: string;
      code?: string;
      outcome?: 'failed' | 'indeterminate';
      retryable?: false;
      data?: unknown;
    }
> {
  try {
    return { success: true, data: await promise };
  } catch (err) {
    const typed = err as {
      code?: unknown;
      outcome?: unknown;
      retryable?: unknown;
      receipt?: unknown;
    };
    if (
      err instanceof Error &&
      typed.code === 'scheduler_run_indeterminate' &&
      typed.outcome === 'indeterminate' &&
      typed.retryable === false
    ) {
      return {
        success: false,
        error: err.message,
        code: typed.code,
        outcome: 'indeterminate',
        retryable: false,
        ...(typed.receipt === undefined ? {} : { data: typed.receipt }),
      };
    }
    if (
      err instanceof Error &&
      typed.code === 'scheduler_run_failed' &&
      typed.outcome === 'failed' &&
      typed.receipt !== undefined
    ) {
      return {
        success: false,
        error: err.message,
        code: typed.code,
        outcome: 'failed',
        data: typed.receipt,
      };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Request failed',
    };
  }
}

export function buildAnalyticsUsagePath(from?: string, to?: string) {
  const params = new URLSearchParams();
  if (from) {
    params.set('from', from);
  }
  if (to) {
    params.set('to', to);
  }
  const query = params.toString();
  return `/api/analytics/usage${query ? `?${query}` : ''}`;
}

export function buildChatRequest(
  message: string,
  conversationId: string,
  options?: {
    delegation?: AgentDelegationContext;
    userId?: string;
    model?: string;
    projectSlug?: string;
  },
) {
  return {
    input: message,
    options: {
      conversationId,
      ...(options?.delegation ? { delegation: options.delegation } : {}),
      ...(options?.userId ? { userId: options.userId } : {}),
      ...(options?.model ? { model: options.model } : {}),
    },
    ...(options?.projectSlug ? { projectSlug: options.projectSlug } : {}),
  };
}

export function createConversationId(agent: string, conversationId?: string) {
  return conversationId || `${agent}:${Date.now()}`;
}

export function buildSentMessageResult(agent: string, conversationId: string) {
  return jsonToolResult({
    success: true,
    conversationId,
    agent,
    message: 'Message sent (non-blocking)',
  });
}

export async function dispatchAgentMessage(
  agent: string,
  message: string,
  conversationId: string,
  options?: {
    delegation?: AgentDelegationContext;
    userId?: string;
  },
) {
  return dispatchAgentMessageAt(
    resolveControlApiBase(),
    agent,
    message,
    conversationId,
    options,
  );
}

export async function dispatchAgentMessageAt(
  apiBase: string,
  agent: string,
  message: string,
  conversationId: string,
  options?: {
    delegation?: AgentDelegationContext;
    userId?: string;
    model?: string;
    projectSlug?: string;
    headers?: Record<string, string>;
    requireAcceptance?: boolean;
  },
) {
  const request = fetch(
    `${apiBase}/api/agents/${encodeURIComponent(agent)}/chat`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options?.headers },
      body: JSON.stringify(buildChatRequest(message, conversationId, options)),
    },
  );
  if (options?.requireAcceptance) {
    let response: Response;
    try {
      response = await request;
    } catch {
      throw new Error(`Agent '${agent}' did not accept the delegated task`);
    }
    if (!response.ok) {
      throw new Error(`Agent '${agent}' did not accept the delegated task`);
    }
    return;
  }
  request.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));
}

export async function navigateTo(path: string) {
  return api('/api/ui', {
    method: 'POST',
    body: JSON.stringify({ command: 'navigate', payload: { path } }),
  });
}
