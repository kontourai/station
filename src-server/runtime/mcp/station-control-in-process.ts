/**
 * Station #90 lane D (station #122): station-control delivered to the Claude
 * Agent SDK as an in-process `type: 'sdk'` MCP server.
 *
 * Why: the SDK hands every non-`sdk` MCP server, env included, to the
 * `claude` CLI as `--mcp-config <json>` in argv, so a stdio station-control
 * child's `INTERNAL_API_TOKEN` and caller token were readable by any
 * same-user process (`ps -axww`). An `sdk` server has no process and no
 * config the CLI serializes: the CLI sends MCP messages over the query's own
 * control pipe and the SDK hands them to `instance.connect(transport)` in
 * this process. No credential leaves Station.
 *
 * Compatibility: the SDK types `instance` as the v1
 * `@modelcontextprotocol/sdk` `McpServer`, but it only ever calls
 * `instance.connect(transport)` with a plain Transport
 * (`start`/`send`/`close`/`onmessage`). Station's v2
 * `@modelcontextprotocol/server` `McpServer.connect` accepts exactly that
 * shape and negotiates the CLI's legacy protocol version, so the same tool
 * registrations the stdio child and the HTTP route serve are served here.
 *
 * Identity: each session gets its own server instance and its own
 * `sdk-in-process` token (assurance `bound`). Every inbound message runs
 * inside the caller context for that session, so tool callbacks and the REST
 * calls they make carry this session's credential. The token lives only in
 * this closure and in loopback request headers Station sends to itself.
 */
import { createHash } from 'node:crypto';
import {
  type TenantExecutionContext,
  tenantExecutionContextFromSession,
} from '@kontourai/station-contracts/tenancy';
import { McpServer, type Transport } from '@modelcontextprotocol/server';
import { createStationBrowserMcpServer } from '../../tools/station-browser-mcp-server.js';
import { registerBrowserTools } from '../../tools/station-control-browser-tools.js';
import { registerDeviceTools } from '../../tools/station-control-device-tools.js';
import {
  createSelectedStationControlMcpServer,
  createStationControlMcpServer,
  StationControlToolRegistry,
} from '../../tools/station-control-mcp-server.js';
import {
  withCodexDirectToolRequests,
  withStationControlCallerBinding,
  withStationControlCallerContext,
  withStationControlExecutionContext,
} from '../../tools/station-control-shared.js';
import {
  resolveStationControlCallerFromToken,
  type StationControlCallerRecordResolver,
} from './station-control-caller.js';
import {
  coordinatorGeneration,
  mintStationControlMcpToken,
  revokeStationControlMcpToken,
  revokeStationControlMcpTokenIfCurrent,
  type StationMcpCredentialPurpose,
  verifyStationControlMcpToken,
  verifyStationControlMcpTokenEntry,
} from './station-control-mcp-token.js';

/** The structural Transport the SDK passes to `instance.connect`. */
interface InProcessTransport {
  onmessage?: (message: unknown, extra?: unknown) => void;
  [key: string]: unknown;
}

/** The browser and device registrations, reached only from one Codex pipe. */
export async function createCodexBoundToolServer(input: {
  sessionId: string;
  tenantExecutionContext?: TenantExecutionContext;
  resolveRecord?: StationControlCallerRecordResolver;
  includeBrowser: boolean;
  includeDevices: boolean;
  dispatch: (request: Request) => Promise<Response>;
  isCurrent: () => boolean;
}) {
  const token = mintStationControlMcpToken(
    input.sessionId,
    'sdk-in-process',
    undefined,
    input.tenantExecutionContext,
    undefined,
    'codex-tools',
    undefined,
    input.isCurrent,
  ).token;
  const server = new McpServer({
    name: 'station-bound-tools',
    version: '1.0.0',
  });
  const registry = new StationControlToolRegistry(server);
  if (input.includeBrowser) registerBrowserTools(registry);
  if (input.includeDevices) registerDeviceTools(registry);
  let nextId = 0;
  let closed = false;
  const pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void }
  >();
  const transport: Transport = {
    start: async () => {},
    close: async () => {},
    send: async (message) => {
      if (!message || typeof message !== 'object' || !('id' in message)) return;
      const response = message as {
        id: number;
        result?: unknown;
        error?: { message?: string };
      };
      const waiting = pending.get(response.id);
      if (!waiting) return;
      pending.delete(response.id);
      if (response.error)
        waiting.reject(
          new Error(response.error.message ?? 'MCP request failed'),
        );
      else waiting.resolve(response.result);
    },
  };
  await server.connect(transport);
  const request = (
    method: string,
    params: Record<string, unknown>,
    current: () => boolean,
  ) => {
    if (!verifyStationControlMcpToken(token) && !closed && input.isCurrent())
      return Promise.reject(new Error('bound-tool-session-restart-required'));
    if (closed || pending.size >= 16 || !current())
      return Promise.reject(new Error('bound-tool-refused'));
    const id = ++nextId;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        withStationControlExecutionContext(
          input.tenantExecutionContext
            ? tenantExecutionContextFromSession(input.tenantExecutionContext)
            : undefined,
          () =>
            withStationControlCallerBinding(
              createHash('sha256').update(token).digest('base64url'),
              () =>
                withStationControlCallerContext(
                  {
                    token,
                    resolve: () =>
                      resolveStationControlCallerFromToken(
                        token,
                        input.resolveRecord,
                      ),
                  },
                  () =>
                    withCodexDirectToolRequests(
                      { token, current, dispatch: input.dispatch },
                      () =>
                        transport.onmessage?.({
                          jsonrpc: '2.0',
                          id,
                          method,
                          params,
                        }),
                    ),
                ),
              current,
            ),
        );
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  };
  const current = () =>
    !closed && input.isCurrent() && !!verifyStationControlMcpToken(token);
  await request(
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'station', version: '1' },
    },
    current,
  );
  transport.onmessage?.({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  const listing = (await request('tools/list', {}, current)) as {
    tools: { name: string; description?: string; inputSchema: unknown }[];
  };
  return {
    tools: listing.tools,
    call: (name: string, args: unknown, invocationCurrent: () => boolean) =>
      request(
        'tools/call',
        { name, arguments: args },
        () => current() && invocationCurrent(),
      ),
    close: async () => {
      closed = true;
      revokeStationControlMcpTokenIfCurrent(
        token,
        input.sessionId,
        'codex-tools',
      );
      for (const item of pending.values())
        item.reject(new Error('bound-tool-refused'));
      pending.clear();
      await server.close();
    },
  };
}

export type CodexBoundToolServer = Awaited<
  ReturnType<typeof createCodexBoundToolServer>
>;

export interface InProcessStationControlServer {
  /** Structurally the SDK's `McpSdkServerConfigWithInstance['instance']`. */
  connect(transport: InProcessTransport): Promise<void>;
  close(): Promise<void>;
}

/**
 * The `sdk-in-process` token each session's in-process servers share. The
 * registry holds one credential per session and API server, so a second server for the
 * same purpose (station-browser beside station-control, #90 D14) must reuse
 * the live one rather than mint a replacement that would revoke it.
 * Cleared with the revocation; a revoked or expired token is never reused.
 */
const inProcessTokens = new Map<
  string,
  Map<StationMcpCredentialPurpose, string>
>();

function inProcessToken(
  sessionId: string,
  tenantExecutionContext: TenantExecutionContext | undefined,
  mode: 'fresh' | 'reuse',
  serverId: StationMcpCredentialPurpose = 'station-control',
  isIssuerCurrent?: () => boolean,
): string {
  if (mode === 'reuse') {
    const existing = inProcessTokens.get(sessionId)?.get(serverId);
    const entry = verifyStationControlMcpTokenEntry(existing);
    if (
      existing &&
      entry?.sessionId === sessionId &&
      entry.channel === 'sdk-in-process' &&
      entry.serverId === serverId
    )
      return existing;
  }
  const { token } = mintStationControlMcpToken(
    sessionId,
    'sdk-in-process',
    undefined,
    tenantExecutionContext,
    undefined,
    serverId,
    undefined,
    isIssuerCurrent,
  );
  const tokens = inProcessTokens.get(sessionId) ?? new Map();
  tokens.set(serverId, token);
  inProcessTokens.set(sessionId, tokens);
  return token;
}

/** Revoke a session's credential and forget its shared in-process token. */
function revokeInProcessSession(sessionId: string): void {
  inProcessTokens.delete(sessionId);
  revokeStationControlMcpToken(sessionId);
}

/**
 * Build one in-process server for a session, serving `createServer`'s
 * registrations as that session's verified caller. station-control mints a
 * fresh token (as it always has); station-browser reuses the session's live
 * one. The caller revokes it with the session.
 */
function createInProcessServer(input: {
  sessionId: string;
  tenantExecutionContext?: TenantExecutionContext;
  resolveRecord?: StationControlCallerRecordResolver;
  createServer: () => {
    connect(transport: never): Promise<void>;
    close(): Promise<void>;
  };
  token: 'fresh' | 'reuse';
  serverId?: StationMcpCredentialPurpose;
  generation?: number;
}): InProcessStationControlServer {
  const derived =
    input.serverId === 'coordinator-control' ||
    input.serverId === 'coordinator-knowledge';
  if (derived && input.generation === undefined)
    throw new Error('Coordinator generation is required.');
  const conversationId =
    input.resolveRecord?.(input.sessionId)?.conversationId ?? input.sessionId;
  const token = inProcessToken(
    input.sessionId,
    input.tenantExecutionContext,
    input.token,
    input.serverId,
    derived
      ? () => coordinatorGeneration(conversationId) === input.generation
      : undefined,
  );
  const server = input.createServer();
  const binding = createHash('sha256').update(token).digest('base64url');
  const tenant = input.tenantExecutionContext
    ? tenantExecutionContextFromSession(input.tenantExecutionContext)
    : undefined;
  const runAsCaller = <T>(operation: () => T): T =>
    withStationControlExecutionContext(tenant, () =>
      withStationControlCallerBinding(
        binding,
        () =>
          withStationControlCallerContext(
            {
              token,
              resolve: () =>
                resolveStationControlCallerFromToken(
                  token,
                  input.resolveRecord,
                ),
            },
            operation,
          ),
        () =>
          verifyStationControlMcpToken(token) !== undefined &&
          (!derived ||
            resolveStationControlCallerFromToken(token, input.resolveRecord) !==
              null),
      ),
    );
  return {
    connect: (transport) =>
      server.connect(
        new Proxy(transport, {
          // Methods run against the SDK's own object, so a transport with
          // private fields keeps working behind the proxy.
          get(target, property) {
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' && property !== 'onmessage'
              ? value.bind(target)
              : value;
          },
          set(target, property, value) {
            // Wrap the server's inbound handler so every request, and the
            // tool callback it reaches, runs as this session's caller.
            target[property as string] =
              property === 'onmessage' && typeof value === 'function'
                ? (message: unknown, extra?: unknown) =>
                    runAsCaller(() => value(message, extra))
                : value;
            return true;
          },
        }) as never,
      ),
    close: () => server.close(),
  };
}

/**
 * The ClaudeAdapter options that deliver station-control in-process. A named
 * export rather than inline closures in `station-runtime.ts` so a test can
 * drive the production mint/revoke pair.
 */
export function claudeInProcessStationControlOptions(
  resolveRecord: () => StationControlCallerRecordResolver | undefined,
  /** Test seam: production serves the real registrations. */
  createServer?: typeof createStationControlMcpServer,
  /** Test seam for the station-browser server (#90 D14). */
  createBrowserServer?: typeof createStationBrowserMcpServer,
): {
  createInProcessStationControl: (
    threadId: string,
    tenantExecutionContext?: TenantExecutionContext,
    allowedTools?: readonly string[],
  ) => InProcessStationControlServer;
  createInProcessCoordinatorStationControl: (
    threadId: string,
    tenantExecutionContext?: TenantExecutionContext,
    allowedTools?: readonly string[],
    generation?: number,
  ) => InProcessStationControlServer;
  createInProcessStationBrowser: (
    threadId: string,
    tenantExecutionContext?: TenantExecutionContext,
  ) => InProcessStationControlServer;
  createInProcessStationKnowledge: (
    threadId: string,
    tenantExecutionContext?: TenantExecutionContext,
    allowedTools?: readonly string[],
    generation?: number,
  ) => InProcessStationControlServer;
  revokeStationControlCallerToken: (threadId: string) => void;
} {
  return {
    createInProcessStationKnowledge: (
      threadId,
      tenantExecutionContext,
      allowedTools,
      generation,
    ) =>
      createInProcessServer({
        sessionId: threadId,
        tenantExecutionContext,
        resolveRecord: (sessionId) => resolveRecord()?.(sessionId),
        createServer: () =>
          createSelectedStationControlMcpServer(
            allowedTools,
            undefined,
            'station-knowledge',
            'bound',
          ),
        token: 'reuse',
        serverId:
          generation !== undefined
            ? 'coordinator-knowledge'
            : 'station-knowledge',
        generation,
      }),
    createInProcessCoordinatorStationControl: (
      threadId,
      tenantExecutionContext,
      allowedTools,
      generation,
    ) =>
      createInProcessServer({
        sessionId: threadId,
        ...(tenantExecutionContext ? { tenantExecutionContext } : {}),
        resolveRecord: (sessionId) => resolveRecord()?.(sessionId),
        createServer: () =>
          createServer
            ? createServer()
            : createSelectedStationControlMcpServer(
                allowedTools,
                undefined,
                'station-control',
                'bound',
              ),
        token: 'fresh',
        serverId: 'coordinator-control',
        generation,
      }),
    createInProcessStationControl: (
      threadId,
      tenantExecutionContext,
      allowedTools,
    ) =>
      createInProcessServer({
        sessionId: threadId,
        ...(tenantExecutionContext ? { tenantExecutionContext } : {}),
        resolveRecord: (sessionId) => resolveRecord()?.(sessionId),
        createServer: () =>
          createServer
            ? createServer()
            : // The in-process channel is the only `bound` one.
              createSelectedStationControlMcpServer(
                allowedTools,
                undefined,
                'station-control',
                'bound',
              ),
        token: 'fresh',
      }),
    // #90 D14: the browser tools as their own narrow server, bound like
    // station-control and sharing its session credential.
    createInProcessStationBrowser: (threadId, tenantExecutionContext) =>
      createInProcessServer({
        sessionId: threadId,
        ...(tenantExecutionContext ? { tenantExecutionContext } : {}),
        resolveRecord: (sessionId) => resolveRecord()?.(sessionId),
        createServer: (createBrowserServer ??
          createStationBrowserMcpServer) as never,
        token: 'reuse',
      }),
    revokeStationControlCallerToken: (threadId) =>
      revokeInProcessSession(threadId),
  };
}
