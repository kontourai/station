import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { AgentDelegationContext } from '@kontourai/station-contracts/agent';
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import { DEFAULT_SERVER_PORT } from '@kontourai/station-shared/ports';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
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
 * Lane D of #90 (archive#122): the VERIFIED identity of the agent session
 * calling a station-control tool.
 *
 * The per-session station-control MCP token (`station-control-mcp-token.ts`)
 * bounds LIFETIME, not authority, and that is unchanged: nothing here narrows
 * what an existing tool may do. This only makes the caller AVAILABLE, derived
 * from a server-minted credential and never from tool input. A `sessionId`
 * (or any other identity) in a tool's arguments is not authority and no code
 * path below reads one.
 *
 * `sessionId` is the session the credential was minted for (Station's
 * provider `threadId`). `projectSlug` and `conversationId` come from the
 * server's own session records for that session, never from the request.
 * `tenant` is present only in-process; the REST projection omits it because
 * tenant context is never a public payload field (`tenancy.ts`).
 */
export interface StationControlCaller {
  readonly sessionId: string;
  /**
   * The principal the session acts for (D5: browser tools check this
   * principal's Project role). Read from the session's ownership record,
   * never from tool input or a request header; `source` names the
   * derivation (see `SessionActingPrincipal` in
   * `services/orchestration/session-authorization.ts`). Absent when the
   * session acts for no attributable principal — a consumer that needs one
   * must fail closed.
   */
  readonly principal?: StationControlCallerPrincipal;
  readonly projectSlug?: string;
  readonly conversationId?: string;
  readonly tenant?: TenantExecutionContext;
}

export interface StationControlCallerPrincipal {
  readonly id: string;
  readonly source:
    | 'session-owner'
    | 'legacy-personal-owner'
    | 'ownerless-single-operator';
}

const CALLER_PRINCIPAL_SOURCES: ReadonlySet<string> = new Set([
  'session-owner',
  'legacy-personal-owner',
  'ownerless-single-operator',
]);

/**
 * The header a station-control tool's REST call carries its caller
 * credential in. The value is the same per-session token the MCP transport
 * verified; Station's REST side re-verifies it
 * (`resolveStationControlCallerForRequest`), so the header is a credential,
 * not a claim.
 */
export const STATION_CONTROL_CALLER_TOKEN_HEADER =
  'x-station-control-caller-token';
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

/** Verified MCP transport identity only; never sourced from public tool input. */
export function withStationControlCallerContext<T>(
  context: StationControlCallerContext,
  operation: () => T,
): T {
  return callerContexts.run(context, operation);
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
  stdioCallerToken =
    typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Test-only reset for the stdio credential. */
export function __resetStationControlStdioCallerCredentialForTests(): void {
  stdioCallerToken = undefined;
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
  const principal = record.principal as Record<string, unknown> | undefined;
  return Object.freeze({
    sessionId: record.sessionId,
    ...(principal &&
    typeof principal.id === 'string' &&
    principal.id.length > 0 &&
    typeof principal.source === 'string' &&
    CALLER_PRINCIPAL_SOURCES.has(principal.source)
      ? {
          principal: Object.freeze({
            id: principal.id,
            source: principal.source as StationControlCallerPrincipal['source'],
          }),
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
