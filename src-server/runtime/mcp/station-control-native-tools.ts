/**
 * #2377 slice D, D1 (decision 4): station-control for Station's own engine,
 * delivered in-process per session the way in-process Claude gets it.
 *
 * Before: the built-in engine reached station-control through a pooled stdio
 * child that held the per-boot internal token and no caller, so every call
 * reached Station caller-less (read-only tools that belong to no person).
 *
 * Now: the tools an agent loads are static descriptions; nothing connects at
 * load (load acts for no one). Each call resolves the calling session from
 * the server-minted turn correlation (`currentAuthorizedTurnCorrelation`),
 * never from tool input, and runs on that session's own in-process server
 * (`createSessionInProcessStationControl`): its own `sdk-in-process` token,
 * assurance `bound`, every inbound message run as that session's verified
 * caller. Station's REST side re-derives the caller from the forwarded token,
 * so the session's recorded owner and Project decide what it may do. No
 * child process and no environment ever holds a credential.
 *
 * The session lifecycle is the built-in engine adapter's
 * (`station-agent-adapter.ts`): it registers a session at start and stops it
 * (closing the server and revoking the token) at stop.
 *
 * A run with no session that an authenticated request starts (the invoke
 * endpoints, a raw tool call) is a "request run"
 * ({@link openNativeStationControlRequestRun}): it acts for the principal
 * Station resolved for that request, on its own server and `bound` token,
 * retired when the response ends.
 *
 * A call with neither an authorized turn of a registered session nor a live
 * request run acts for no one and is answered with the typed
 * `station_control_caller_required` refusal.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import type { MCPToolInfo } from '@kontourai/station-shared/mcp';
import { createSelectedStationControlMcpServer } from '../../tools/station-control-mcp-server.js';
import {
  stationControlRefusal,
  stationControlRefusalBody,
} from '../../tools/station-control-policy.js';
import { jsonToolResult } from '../../tools/station-control-shared.js';
import {
  currentTenantExecutionContext,
  isHostedTenantExecutionRequired,
} from '../bootstrap/runtime-tenant-context.js';
import { currentAuthorizedTurnCorrelation } from '../conversation/authorized-turn-correlation.js';
import { extractMCPAppsToolMetadata } from './mcp-apps-metadata.js';
import {
  createStationControlCallerRecordResolver,
  type StationControlCallerRecordResolver,
} from './station-control-caller.js';
import {
  createSessionInProcessStationControl,
  type InProcessStationControlServer,
  revokeSessionInProcessStationControl,
} from './station-control-in-process.js';
import {
  forgetStationControlRequestRun,
  registerStationControlRequestRun,
} from './station-control-request-runs.js';

/** The built-in station-control server id, as agents and the loader name it. */
const SERVER_ID = 'station-control';

/** A pending call is bounded so a wedged tool cannot pile up requests. */
const MAX_PENDING_REQUESTS = 16;

interface InProcessClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Both an McpServer and a per-session in-process server; each types its
 * own transport, and both accept the structural one built below.
 */
interface ConnectableServer {
  connect(transport: never): Promise<void>;
  close(): Promise<void>;
}

/**
 * A minimal JSON-RPC client over the structural transport the SDK hands an
 * in-process server (`start`/`send`/`close`/`onmessage`). The server sets
 * `onmessage`; a per-session server wraps it so each inbound message runs as
 * the session's caller.
 */
async function connectInProcessClient(
  server: ConnectableServer,
): Promise<InProcessClient> {
  let nextId = 0;
  let closed = false;
  const pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  const transport: {
    onmessage?: (message: unknown, extra?: unknown) => void;
    start(): Promise<void>;
    send(message: unknown): Promise<void>;
    close(): Promise<void>;
  } = {
    start: async () => {},
    close: async () => {},
    send: async (message) => {
      if (!message || typeof message !== 'object') return;
      const record = message as {
        id?: unknown;
        method?: unknown;
        result?: unknown;
        error?: { message?: string };
      };
      if (typeof record.method === 'string') {
        // A server-initiated request (an elicitation form, sampling): this
        // channel has no person to ask, the same as the pooled child it
        // replaces, so it is refused rather than left waiting.
        if (record.id !== undefined)
          transport.onmessage?.({
            jsonrpc: '2.0',
            id: record.id,
            error: {
              code: -32601,
              message: 'This Station session cannot answer server requests.',
            },
          });
        return;
      }
      if (typeof record.id !== 'number') return;
      const waiting = pending.get(record.id);
      if (!waiting) return;
      pending.delete(record.id);
      if (record.error)
        waiting.reject(
          new Error(record.error.message ?? 'Station control request failed'),
        );
      else waiting.resolve(record.result);
    },
  };
  await server.connect(transport as never);
  const request = (method: string, params: Record<string, unknown>) => {
    if (closed)
      return Promise.reject(new Error('Station control session has stopped.'));
    if (pending.size >= MAX_PENDING_REQUESTS)
      return Promise.reject(
        new Error('Too many Station control calls are in flight.'),
      );
    const id = ++nextId;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        transport.onmessage?.({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'station-agent', version: '1' },
  });
  transport.onmessage?.({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  return {
    request,
    close: async () => {
      closed = true;
      for (const waiting of pending.values())
        waiting.reject(new Error('Station control session has stopped.'));
      pending.clear();
      await server.close();
    },
  };
}

// ── catalog ─────────────────────────────────────────────────────────────────

let catalog: Promise<readonly MCPToolInfo[]> | undefined;

/**
 * The tools a `bound` session is offered, as the MCP loaders describe them.
 * Listed once per process from the same registrations every session serves;
 * listing calls no tool and acts for no one.
 */
export function nativeStationControlToolCatalog(): Promise<
  readonly MCPToolInfo[]
> {
  catalog ??= (async () => {
    const client = await connectInProcessClient(
      createSelectedStationControlMcpServer(
        undefined,
        undefined,
        'station-control',
        'bound',
      ),
    );
    try {
      const listing = (await client.request('tools/list', {})) as {
        tools?: {
          name: string;
          description?: string;
          inputSchema?: unknown;
          annotations?: { readOnlyHint?: boolean };
          _meta?: Record<string, unknown>;
        }[];
      };
      return Object.freeze(
        (listing.tools ?? []).map((tool): MCPToolInfo => {
          const resourceUri = extractMCPAppsToolMetadata(tool).resourceUri;
          return {
            name: `${SERVER_ID}_${tool.name}`,
            originalName: tool.name,
            serverId: SERVER_ID,
            description: tool.description,
            readOnly: tool.annotations?.readOnlyHint,
            inputSchema: tool.inputSchema,
            ...(tool._meta ? { _meta: tool._meta } : {}),
            ...(resourceUri ? { ui: { resourceUri } } : {}),
          };
        }),
      );
    } finally {
      await client.close();
    }
  })().catch((error: unknown) => {
    catalog = undefined;
    throw error;
  });
  return catalog;
}

// ── sessions ────────────────────────────────────────────────────────────────

interface NativeStationControlSession {
  active: boolean;
  readonly tenantExecutionContext?: TenantExecutionContext;
  readonly resolveRecord?: StationControlCallerRecordResolver;
  readonly createServer?: () => InProcessStationControlServer;
  client?: Promise<InProcessClient>;
}

const sessions = new Map<string, NativeStationControlSession>();
/** The request run the current async work belongs to, if any. */
const requestRuns = new AsyncLocalStorage<string>();

async function closeSession(session: NativeStationControlSession) {
  session.active = false;
  const client = session.client;
  session.client = undefined;
  await client?.then(
    (open) => open.close(),
    () => {},
  );
}

/**
 * Register a built-in engine session. Its server and credential are created
 * on its first call, and retired by {@link stopNativeStationControlSession}.
 */
export function startNativeStationControlSession(
  sessionId: string,
  options: {
    tenantExecutionContext?: TenantExecutionContext;
    resolveRecord?: StationControlCallerRecordResolver;
    /** Test seam: production builds the session's real in-process server. */
    createServer?: () => InProcessStationControlServer;
  } = {},
): void {
  const prior = sessions.get(sessionId);
  if (prior) {
    // A replaced registration retires its credential, not only its client.
    revokeSessionInProcessStationControl(sessionId);
    void closeSession(prior);
  }
  sessions.set(sessionId, { active: true, ...options });
}

/** Retire a session: close its server and revoke its credential. */
export async function stopNativeStationControlSession(
  sessionId: string,
): Promise<void> {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  revokeSessionInProcessStationControl(sessionId);
  if (session) await closeSession(session);
}

function callerRequired() {
  return jsonToolResult(
    stationControlRefusalBody(
      stationControlRefusal('station_control_caller_required'),
    ),
  );
}

function openSessionClient(
  sessionId: string,
  session: NativeStationControlSession,
): Promise<InProcessClient> {
  const server =
    session.createServer?.() ??
    createSessionInProcessStationControl({
      sessionId,
      ...(session.tenantExecutionContext
        ? { tenantExecutionContext: session.tenantExecutionContext }
        : {}),
      ...(session.resolveRecord
        ? { resolveRecord: session.resolveRecord }
        : {}),
    });
  return connectInProcessClient(server);
}

/**
 * Call one station-control tool as the session the current authorized turn
 * belongs to. Never reads an identity from `args`.
 */
export async function callNativeStationControlTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const correlation = currentAuthorizedTurnCorrelation();
  // A session turn wins; otherwise the request run this work belongs to.
  const sessionId = correlation?.sessionId ?? requestRuns.getStore();
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!sessionId || !session?.active) return callerRequired();
  // Hosted: a session acts only inside the tenant it was started for.
  const tenant = session.tenantExecutionContext?.tenantId;
  if (!tenant && isHostedTenantExecutionRequired())
    throw new Error(
      'Tenant execution context is required for station-control.',
    );
  const current = currentTenantExecutionContext()?.tenantId;
  if (current !== undefined && current !== tenant)
    throw new Error(
      'The station-control session belongs to another tenant execution context.',
    );
  if (!session.client) {
    const opening = openSessionClient(sessionId, session);
    session.client = opening;
    opening.catch(() => {
      if (session.client === opening) session.client = undefined;
    });
  }
  const client = await session.client;
  if (!session.active) throw new Error('Station control session has stopped.');
  return client.request('tools/call', { name, arguments: args });
}

/**
 * Open a request run for an authenticated request with no session: tool
 * calls made inside {@link NativeStationControlRequestRun.run} act for
 * `principalId` as a `bound` caller (the credential never leaves Station).
 * `close` revokes the credential and retires the server; call it when the
 * response has ended, streamed bodies included.
 */
export interface NativeStationControlRequestRun {
  run<T>(work: () => T): T;
  close(): Promise<void>;
}

export function openNativeStationControlRequestRun(input: {
  principalId: string;
  tenantExecutionContext?: TenantExecutionContext;
}): NativeStationControlRequestRun {
  const runId = registerStationControlRequestRun({
    principalId: input.principalId,
  });
  startNativeStationControlSession(runId, {
    ...(input.tenantExecutionContext
      ? { tenantExecutionContext: input.tenantExecutionContext }
      : {}),
    // Only the run's own record: a request run has no session records.
    resolveRecord: createStationControlCallerRecordResolver({
      actingPrincipal: () => undefined,
      startedMetadata: () => undefined,
      localProjectId: () => undefined,
      conversationId: () => undefined,
    }),
  });
  let closing: Promise<void> | undefined;
  return {
    run: (work) => requestRuns.run(runId, work),
    close: () => {
      closing ??= (async () => {
        forgetStationControlRequestRun(runId);
        await stopNativeStationControlSession(runId);
      })();
      return closing;
    },
  };
}

/** Test-only: forget every session and the cached catalog. */
export async function __resetNativeStationControlForTests(): Promise<void> {
  const open = [...sessions.values()];
  sessions.clear();
  catalog = undefined;
  await Promise.all(open.map(closeSession));
}
