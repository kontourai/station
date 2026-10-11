/**
 * MCP Client Factory — creates MCP clients from tool definitions.
 *
 * Supports stdio, SSE, and Streamable HTTP transports.
 * Used by both the core server and CLI dev server.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  Client,
  type ElicitResult,
  type FetchLike,
  type OAuthClientProvider,
  ProtocolError,
  ProtocolErrorCode,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  type ClaudeDesktopConfig,
  normalizeMcpToolDef,
} from './portability.js';
import type { ToolDef } from './types.js';

export type { MCPToolUICsp } from './mcp-ui-csp.js';
// The CSP builder lives in a node-free module so the browser UI can import it as
// a value without dragging this file's MCP SDK transports into the web bundle.
export { buildMcpUiCsp, safeCspDomains } from './mcp-ui-csp.js';

export interface MCPToolInfo {
  name: string; // prefixed: "{serverId}_{toolName}"
  originalName: string; // raw name from MCP server
  serverId: string;
  description?: string;
  inputSchema?: any;
  _meta?: Record<string, unknown>;
  ui?: MCPToolUIMetadata;
}

/** Declared permission-policy requests from resource-content metadata. */
export interface MCPToolUIPermissions {
  camera?: unknown;
  microphone?: unknown;
  geolocation?: unknown;
  clipboardWrite?: unknown;
}

export interface MCPToolUIMetadata {
  resourceUri: string;
}

export type MCPToolUIResolutionStatus =
  | 'invalid_ref'
  | 'missing_server'
  | 'missing_tool'
  | 'missing_resource'
  | 'render_revoked'
  | 'unsupported'
  | 'success';

export interface MCPToolUIResolution {
  status: MCPToolUIResolutionStatus;
  ref: string;
  serverId?: string;
  toolName?: string;
  resourceUri?: string;
  reason?: string;
}

/**
 * Who answers a server's form elicitation: the one Station turn whose tool
 * call is in flight on this connection. `params` is the SDK-validated
 * `elicitation/create` params; `signal` aborts when the server cancels.
 */
export type MCPElicitationRoute = (request: {
  serverId: string;
  params: unknown;
  signal: AbortSignal;
}) => Promise<ElicitResult>;

export interface MCPConnection {
  client: Client;
  serverId: string;
  tools: MCPToolInfo[];
  negotiation: MCPNegotiation;
  close: () => Promise<void>;
  disconnect: () => Promise<void>;
  /**
   * Run `operation` with `route` answering an elicitation the server sends
   * while one of its requests is in flight. Present on owned connections.
   * A connection is shared across turns and callers, and the client cannot
   * tell which in-flight request an elicitation belongs to, so the connection
   * counts every request in flight on it that could elicit, bridged or not
   * (see `NON_ELICITING_METHODS_2026` for the ones that cannot): an elicitation is
   * routed only when exactly one request is in flight and that request has a
   * route, and is refused otherwise rather than shown to a person who may not
   * own it.
   */
  withElicitationRoute?: <T>(
    route: MCPElicitationRoute,
    operation: () => Promise<T>,
  ) => Promise<T>;
  /** Present on owned connections; false after a local retirement fence. */
  isUsable?: () => boolean;
  localState?: () => ReturnType<MCPPreparedConnection['inspect']>;
}

/** Local SDK resources only. Never a child-process or remote-effect drain receipt. */
export interface MCPPreparedConnection {
  connect(): Promise<MCPConnection>;
  retainForOAuth(): void;
  finishAuth(params: URLSearchParams): Promise<void>;
  close(): Promise<void>;
  inspect(): {
    phase:
      | 'prepared'
      | 'connecting'
      | 'connected'
      | 'failed'
      | 'oauth'
      | 'closing'
      | 'close-failed'
      | 'closed';
    pendingOperations: number;
  };
}

export interface MCPNegotiation {
  era: 'modern' | 'legacy';
  protocolVersion?: string;
  serverInfo?: { name: string; version: string };
  serverCapabilities?: Record<string, unknown>;
  extensionIds: string[];
  fellBackToLegacy: boolean;
  discoverResult?: Record<string, unknown>;
}

export interface MCPManagerOptions {
  /** OAuth provider for remote HTTP transports. */
  authProvider?: OAuthClientProvider;
  /** Internal OAuth seam used to complete a browser redirect round trip. */
  onTransport?: (transport: Transport) => void;
  /** Called when a server connects or fails */
  onStatus?: (
    serverId: string,
    status: 'connected' | 'failed',
    error?: string,
  ) => void;
  /** Called after version negotiation and before tool discovery. */
  onNegotiated?: (serverId: string, negotiation: MCPNegotiation) => void;
}

/**
 * Requests that cannot lead to an elicitation on the 2026-07-28 revision,
 * where only `tools/call`, `prompts/get` and `resources/read` may answer
 * `input_required` and a server can no longer send `elicitation/create` as
 * a request of its own. They are not counted as in flight, so a catalog
 * read does not make a turn's form ambiguous. The 2025 era sets no such
 * limit (a server may send a request during any client request, and stdio
 * does not say which), so there every request counts.
 */
const NON_ELICITING_METHODS_2026: ReadonlySet<string> = new Set([
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
  'ping',
  'completion/complete',
]);

/** The JSON-RPC method each client helper sends. */
const CLIENT_HELPER_METHODS: Readonly<Record<string, string>> = {
  callTool: 'tools/call',
  getPrompt: 'prompts/get',
  readResource: 'resources/read',
  listTools: 'tools/list',
  listPrompts: 'prompts/list',
  listResources: 'resources/list',
  listResourceTemplates: 'resources/templates/list',
  ping: 'ping',
  complete: 'completion/complete',
};

/** The JSON-RPC method a guarded client call sends, when it can be read. */
function clientRequestMethod(
  property: string | symbol,
  args: readonly unknown[],
): string | undefined {
  if (typeof property !== 'string') return undefined;
  if (Object.hasOwn(CLIENT_HELPER_METHODS, property))
    return CLIENT_HELPER_METHODS[property];
  if (property === 'request' && isRecord(args[0]))
    return typeof args[0].method === 'string' ? args[0].method : undefined;
  return undefined;
}

function hasForbiddenElicitationField(request: unknown): boolean {
  if (
    !isRecord(request) ||
    request.method !== 'elicitation/create' ||
    !isRecord(request.params)
  )
    return false;
  const schema = request.params.requestedSchema;
  return (
    isRecord(schema) &&
    isRecord(schema.properties) &&
    Object.hasOwn(schema.properties, '__proto__')
  );
}

function hasForbiddenInputRequiredField(message: unknown): boolean {
  if (
    !isRecord(message) ||
    !isRecord(message.result) ||
    message.result.resultType !== 'input_required' ||
    !isRecord(message.result.inputRequests)
  )
    return false;
  return Object.values(message.result.inputRequests).some(
    hasForbiddenElicitationField,
  );
}

const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';
const MCP_APPS_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * Client capabilities Station declares. Form-mode elicitation only: URL mode
 * sends the person to a third-party page Station cannot vouch for, so it is
 * not declared and the SDK refuses it. Sampling is not declared.
 */
export const STATION_MCP_CLIENT_CAPABILITIES = {
  elicitation: { form: {} },
  extensions: {
    [MCP_APPS_EXTENSION_ID]: {
      mimeTypes: [MCP_APPS_MIME_TYPE],
    },
  },
};

/**
 * Create an MCP client from a tool definition.
 * Returns the connected client with its tool catalog.
 */
export function prepareMCPConnection(
  def: ToolDef,
  opts?: MCPManagerOptions,
  isCurrent: () => boolean = () => true,
): MCPPreparedConnection {
  const normalized = normalizeTransportConfig(def);
  // Normalization is effect-free. The caller owns this handle before either
  // constructor runs, including a partial constructor/observer failure.
  let transport: Transport | undefined;
  let client: Client | undefined;
  let phase: ReturnType<MCPPreparedConnection['inspect']>['phase'] = 'prepared';
  let retired = false;
  let activity = 0;
  const pending = new Set<Promise<void>>();
  let connecting: Promise<MCPConnection> | undefined;
  let closing: Promise<void> | undefined;
  // Every client request in flight on this connection, with the route of
  // the `withElicitationRoute` operation that issued it, if any. A request is
  // registered by the guarded client itself, so no caller can leave one out.
  type ElicitationScope = { route: MCPElicitationRoute; open: boolean };
  const inFlight = new Set<{ scope: ElicitationScope | undefined }>();
  const elicitationScope = new AsyncLocalStorage<ElicitationScope>();
  function inFlightRequest<T>(operation: () => T): T {
    const scope = elicitationScope.getStore();
    const entry = { scope: scope?.open ? scope : undefined };
    inFlight.add(entry);
    try {
      const value = operation();
      if (value && typeof (value as { then?: unknown }).then === 'function')
        return Promise.resolve(value).finally(() =>
          inFlight.delete(entry),
        ) as T;
      inFlight.delete(entry);
      return value;
    } catch (error) {
      inFlight.delete(entry);
      throw error;
    }
  }
  const current = () => !retired && isCurrent() === true;
  const assertCurrent = () => {
    if (!current())
      throw new Error('MCP local connection is no longer current');
  };
  function track<T>(operation: () => T): T {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    pending.add(settled);
    activity++;
    const finish = () => {
      activity++;
      pending.delete(settled);
      settle();
    };
    try {
      const value = operation();
      if (value && typeof (value as { then?: unknown }).then === 'function')
        return Promise.resolve(value).finally(finish) as T;
      finish();
      return value;
    } catch (error) {
      finish();
      throw error;
    }
  }
  // SDK-internal close calls and our close use the same exact in-flight
  // promise. Later activity requires another close; rejection is retryable
  // only after that close actually settled, never by overlapping it.
  function closeOnce(operation: () => Promise<void>) {
    let flight: Promise<void> | undefined;
    let unsettled = false;
    let successful = false;
    let closedActivity = -1;
    return () => {
      if (flight && (unsettled || (successful && closedActivity === activity)))
        return flight;
      unsettled = true;
      successful = false;
      closedActivity = activity;
      flight = Promise.resolve()
        .then(operation)
        .then(
          () => {
            successful = true;
          },
          (error) => {
            throw error;
          },
        )
        .finally(() => {
          unsettled = false;
        });
      return flight;
    };
  }
  let closeTransport = async () => {};
  let closeClient = async () => {};
  async function closePair() {
    const results = await Promise.allSettled([closeClient(), closeTransport()]);
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('MCP local SDK cleanup did not settle successfully');
  }
  const handle: MCPPreparedConnection = {
    inspect: () => ({ phase, pendingOperations: pending.size }),
    connect() {
      assertCurrent();
      if (connecting) return connecting;
      phase = 'connecting';
      connecting = track(() =>
        Promise.resolve().then(async () => {
          try {
            assertCurrent();
            transport = createMCPTransport(normalized, opts?.authProvider);
            const rawTransport = transport;
            const originalTransportClose =
              rawTransport.close.bind(rawTransport);
            const physicalClose = closeOnce(originalTransportClose);
            rawTransport.close = physicalClose;
            // SDK stdio negotiation temporarily wraps close to cancel its probe.
            // Preserve that hook without making the wrapper recurse into itself.
            let currentTransportClose = physicalClose;
            closeTransport = () => currentTransportClose();
            const guardedTransport = new Proxy(rawTransport, {
              get(target, property) {
                if (property === 'close') return currentTransportClose;
                if (property === 'constructor') return target.constructor;
                const value = Reflect.get(target, property, target);
                if (typeof value !== 'function') return value;
                return (...args: unknown[]) => {
                  // SDK negotiation may close/restart a transport. Once retired,
                  // no later start/send may resurrect that local handle.
                  assertCurrent();
                  return track(() => {
                    const result = Reflect.apply(value, target, args);
                    if (
                      result &&
                      typeof (result as { then?: unknown }).then === 'function'
                    )
                      return Promise.resolve(result).then((settled) => {
                        assertCurrent();
                        return settled;
                      });
                    assertCurrent();
                    return result;
                  });
                };
              },
              set(target, property, value) {
                if (property === 'onmessage' && typeof value === 'function') {
                  const onmessage: NonNullable<Transport['onmessage']> = (
                    ...args
                  ) => {
                    const message = args[0];
                    if (
                      'id' in message &&
                      (hasForbiddenElicitationField(message) ||
                        hasForbiddenInputRequiredField(message))
                    ) {
                      const refusal = {
                        jsonrpc: '2.0' as const,
                        id: message.id,
                        error: {
                          code: ProtocolErrorCode.InvalidParams,
                          message:
                            'Station refuses MCP elicitation fields named __proto__.',
                        },
                      };
                      // Legacy asks need a wire reply; a modern input-required
                      // result must fail the owning client call before decoding.
                      if ('method' in message) {
                        if (!current()) return;
                        void track(() => target.send(refusal)).catch((error) =>
                          target.onerror?.(
                            error instanceof Error
                              ? error
                              : new Error('MCP refusal could not be sent'),
                          ),
                        );
                      } else value(refusal, args[1]);
                      return;
                    }
                    value(...args);
                  };
                  return Reflect.set(target, property, onmessage, target);
                }
                if (property === 'close') {
                  currentTransportClose = value;
                  return true;
                }
                return Reflect.set(target, property, value, target);
              },
            });
            client = new Client(
              { name: 'station', version: '0.1.0' },
              {
                capabilities: STATION_MCP_CLIENT_CAPABILITIES,
                versionNegotiation: {
                  mode: 'auto',
                  ...(def.timeouts?.startupMs
                    ? { probe: { timeoutMs: def.timeouts.startupMs } }
                    : {}),
                },
              },
            );
            const rawClient = client;
            // Legacy servers send this as a request; on the 2026-07-28 era the
            // SDK fulfils an embedded `input_required` through this same
            // handler. Neither tells the handler which request it belongs to
            // (the context carries no originating request id), so it is
            // answered only when one request is in flight and it has a route.
            rawClient.setRequestHandler(
              'elicitation/create',
              async (request, ctx) => {
                const requests = [...inFlight];
                const route =
                  requests.length === 1 && requests[0].scope?.open
                    ? requests[0].scope.route
                    : undefined;
                if (!route)
                  throw new ProtocolError(
                    ProtocolErrorCode.InvalidRequest,
                    requests.length > 1
                      ? 'Station cannot tell which of several concurrent requests on this server this elicitation belongs to.'
                      : 'No Station turn is waiting on this server, so nobody can answer this elicitation.',
                  );
                return route({
                  serverId: def.id,
                  params: request.params,
                  signal: ctx.mcpReq.signal,
                });
              },
            );
            const originalClose = rawClient.close.bind(rawClient);
            closeClient = closeOnce(originalClose);
            rawClient.close = closeClient;
            opts?.onTransport?.(guardedTransport);
            assertCurrent();
            await rawClient.connect(guardedTransport);
            assertCurrent();
            opts?.onStatus?.(def.id, 'connected');
            const negotiation = describeNegotiation(rawClient);
            opts?.onNegotiated?.(def.id, negotiation);

            // Discover tools
            assertCurrent();
            const result = await rawClient.listTools();
            assertCurrent();
            const tools: MCPToolInfo[] = (result.tools || []).map((t) => ({
              name: `${def.id}_${t.name}`,
              originalName: t.name,
              serverId: def.id,
              description: t.description,
              inputSchema: t.inputSchema,
              _meta: isRecord((t as { _meta?: unknown })._meta)
                ? (t as { _meta: Record<string, unknown> })._meta
                : undefined,
              ui: extractMCPToolUIMetadata(t),
            }));

            const guardedClient = new Proxy(rawClient, {
              get(target, property) {
                if (property === 'close') return handle.close;
                if (property === 'constructor') return target.constructor;
                const value = Reflect.get(target, property, target);
                if (typeof value !== 'function') return value;
                return (...args: unknown[]) => {
                  assertCurrent();
                  if (phase !== 'connected')
                    throw new Error('MCP local connection is unavailable');
                  const run = () => Reflect.apply(value, target, args);
                  return track(() =>
                    negotiation.era === 'modern' &&
                    NON_ELICITING_METHODS_2026.has(
                      clientRequestMethod(property, args) ?? '',
                    )
                      ? run()
                      : inFlightRequest(run),
                  );
                };
              },
              set: (target, property, value) =>
                Reflect.set(target, property, value, target),
            });
            phase = 'connected';
            return {
              client: guardedClient,
              serverId: def.id,
              tools,
              negotiation,
              close: handle.close,
              disconnect: handle.close,
              isUsable: () => current() && phase === 'connected',
              localState: handle.inspect,
              withElicitationRoute: async (route, operation) => {
                const scope: ElicitationScope = { route, open: true };
                try {
                  return await elicitationScope.run(scope, operation);
                } finally {
                  // Work this operation started but did not await, or that
                  // inherits its async context later, no longer has a route.
                  scope.open = false;
                }
              },
            };
          } catch (error) {
            if (!retired) phase = 'failed';
            opts?.onStatus?.(def.id, 'failed', 'Tool server connection failed');
            throw error;
          }
        }),
      );
      return connecting;
    },
    retainForOAuth() {
      assertCurrent();
      if (phase !== 'failed' || !transport || !('finishAuth' in transport))
        throw new Error('MCP OAuth continuation is unavailable');
      phase = 'oauth';
    },
    async finishAuth(params) {
      assertCurrent();
      if (phase !== 'oauth' || !transport || !('finishAuth' in transport))
        throw new Error('MCP OAuth continuation is unavailable');
      await track(() =>
        (
          transport as Transport & {
            finishAuth(value: URLSearchParams): Promise<void>;
          }
        ).finishAuth(params),
      );
      assertCurrent();
    },
    close() {
      retired = true;
      if (phase === 'closed') return Promise.resolve();
      if (closing) return closing;
      phase = 'closing';
      closing = (async () => {
        const before = activity;
        await closePair();
        // A timeout outside this promise does not release custody. In
        // particular late connect/discovery must finish before the final close.
        while (pending.size) await Promise.all([...pending]);
        if (activity !== before) await closePair();
        phase = 'closed';
      })().catch((error) => {
        phase = 'close-failed';
        closing = undefined;
        throw error;
      });
      return closing;
    },
  };
  return handle;
}

/** Compatibility helper; supported owners use prepareMCPConnection before awaiting. */
export async function connectMCP(
  def: ToolDef,
  opts?: MCPManagerOptions,
): Promise<MCPConnection> {
  const prepared = prepareMCPConnection(def, opts);
  try {
    return await prepared.connect();
  } catch (error) {
    // Keep the failed call pending while cleanup is pending. A rejected cleanup
    // carries the prepared handle non-enumerably for explicit caller recovery.
    try {
      await prepared.close();
    } catch {
      const failure = new Error('MCP local SDK cleanup failed');
      Object.defineProperty(failure, 'localConnection', { value: prepared });
      throw failure;
    }
    throw error;
  }
}

function describeNegotiation(client: Client): MCPNegotiation {
  const era = client.getProtocolEra() ?? 'legacy';
  const serverInfo = client.getServerVersion();
  const capabilities = client.getServerCapabilities();
  const discover = client.getDiscoverResult();
  const extensions = isRecord(capabilities?.extensions)
    ? capabilities.extensions
    : undefined;

  return {
    era,
    protocolVersion: client.getNegotiatedProtocolVersion(),
    serverInfo: serverInfo
      ? { name: serverInfo.name, version: serverInfo.version }
      : undefined,
    serverCapabilities: isRecord(capabilities)
      ? (capabilities as Record<string, unknown>)
      : undefined,
    extensionIds: extensions ? Object.keys(extensions).sort() : [],
    fellBackToLegacy: era === 'legacy',
    discoverResult: isRecord(discover)
      ? (discover as Record<string, unknown>)
      : undefined,
  };
}

function extractMCPToolUIMetadata(
  tool: unknown,
): MCPToolUIMetadata | undefined {
  if (!isRecord(tool)) return undefined;

  const meta = isRecord(tool._meta) ? tool._meta : undefined;
  const ui = isRecord(meta?.ui) ? meta.ui : undefined;
  const resourceUri =
    typeof ui?.resourceUri === 'string'
      ? ui.resourceUri
      : typeof meta?.['ui/resourceUri'] === 'string'
        ? meta['ui/resourceUri']
        : undefined;
  return resourceUri ? { resourceUri } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Call a tool on an MCP connection.
 */
export async function callTool(
  conn: MCPConnection,
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  // Accept both prefixed ("server_tool") and raw ("tool") names
  const originalName = toolName.startsWith(`${conn.serverId}_`)
    ? toolName.slice(conn.serverId.length + 1)
    : toolName;

  const result = await conn.client.callTool({
    name: originalName,
    arguments: args,
  });
  return result;
}

function originBoundLiteralHeaderFetch(
  endpoint: string,
  literals: Record<string, string>,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): FetchLike {
  const endpointOrigin = new URL(endpoint).origin;
  return async (input, init) => {
    const requestUrl = typeof input === 'string' ? new URL(input) : input;
    if (requestUrl.origin !== endpointOrigin) {
      return fetchImpl(input, { ...init, redirect: 'error' });
    }
    const headers = new Headers(literals);
    new Headers(init?.headers).forEach((value, name) => {
      // The SDK/client is always the final writer. This automatically covers
      // future generated HTTP or MCP headers without a driftable denylist.
      headers.set(name, value);
    });
    return fetchImpl(input, { ...init, headers, redirect: 'error' });
  };
}

export function createMCPTransport(
  def: ToolDef,
  authProvider?: OAuthClientProvider,
): Transport {
  const transport = def.transport || (def.command ? 'stdio' : undefined);

  switch (transport) {
    case 'stdio':
      if (!def.command)
        throw new Error(`Tool '${def.id}': stdio transport requires 'command'`);
      return new StdioClientTransport({
        command: def.command,
        args: def.args,
        env: { ...process.env, ...(def.env || {}) } as Record<string, string>,
        cwd: def.cwd,
      });

    case 'sse':
      if (!def.endpoint)
        throw new Error(`Tool '${def.id}': sse transport requires 'endpoint'`);
      return new SSEClientTransport(new URL(def.endpoint), { authProvider });

    case 'streamable-http':
      if (!def.endpoint)
        throw new Error(
          `Tool '${def.id}': streamable-http transport requires 'endpoint'`,
        );
      return new StreamableHTTPClientTransport(new URL(def.endpoint), {
        authProvider,
        requestInit: { redirect: 'error' },
        ...(def.headers
          ? { fetch: originBoundLiteralHeaderFetch(def.endpoint, def.headers) }
          : {}),
      });

    default:
      if (def.command) {
        return new StdioClientTransport({
          command: def.command,
          args: def.args,
          env: { ...process.env, ...(def.env || {}) } as Record<string, string>,
          cwd: def.cwd,
        });
      }
      throw new Error(
        `Tool '${def.id}': cannot determine transport (set 'transport' or 'command')`,
      );
  }
}

function normalizeTransportConfig(def: ToolDef): ToolDef {
  const result = normalizeMcpToolDef(def);
  if (!result.normalized) {
    throw new Error(
      result.losses[0]?.message ||
        `Tool '${def.id}': unsupported MCP configuration for transport`,
    );
  }

  const normalized = result.normalized;
  return {
    id: normalized.id,
    kind: 'mcp',
    displayName: normalized.displayName,
    description: normalized.description,
    transport: normalized.transport,
    command: normalized.command,
    args: normalized.args,
    cwd: def.cwd,
    endpoint: normalized.endpoint,
    headers: def.headers,
    env: normalized.env as ClaudeDesktopConfig['mcpServers'][string]['env'],
    exposedTools: normalized.exposedTools,
    timeouts: normalized.timeouts,
  };
}
