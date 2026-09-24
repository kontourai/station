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
import { createStationBrowserMcpServer } from '../../tools/station-browser-mcp-server.js';
import { createStationControlMcpServer } from '../../tools/station-control-mcp-server.js';
import {
  withStationControlCallerBinding,
  withStationControlCallerContext,
  withStationControlExecutionContext,
} from '../../tools/station-control-shared.js';
import {
  resolveStationControlCallerFromToken,
  type StationControlCallerRecordResolver,
} from './station-control-caller.js';
import {
  mintStationControlMcpToken,
  revokeStationControlMcpToken,
  verifyStationControlMcpToken,
  verifyStationControlMcpTokenEntry,
} from './station-control-mcp-token.js';

/** The structural Transport the SDK passes to `instance.connect`. */
interface InProcessTransport {
  onmessage?: (message: unknown, extra?: unknown) => void;
  [key: string]: unknown;
}

export interface InProcessStationControlServer {
  /** Structurally the SDK's `McpSdkServerConfigWithInstance['instance']`. */
  connect(transport: InProcessTransport): Promise<void>;
  close(): Promise<void>;
}

/**
 * The `sdk-in-process` token each session's in-process servers share. The
 * registry holds one credential per session, so a second server for the
 * same session (station-browser beside station-control, #90 D14) must reuse
 * the live one rather than mint a replacement that would revoke it.
 * Cleared with the revocation; a revoked or expired token is never reused.
 */
const inProcessTokens = new Map<string, string>();

function inProcessToken(
  sessionId: string,
  tenantExecutionContext: TenantExecutionContext | undefined,
  mode: 'fresh' | 'reuse',
): string {
  if (mode === 'reuse') {
    const existing = inProcessTokens.get(sessionId);
    const entry = verifyStationControlMcpTokenEntry(existing);
    if (
      existing &&
      entry?.sessionId === sessionId &&
      entry.channel === 'sdk-in-process'
    )
      return existing;
  }
  const { token } = mintStationControlMcpToken(
    sessionId,
    'sdk-in-process',
    undefined,
    tenantExecutionContext,
  );
  inProcessTokens.set(sessionId, token);
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
}): InProcessStationControlServer {
  const token = inProcessToken(
    input.sessionId,
    input.tenantExecutionContext,
    input.token,
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
        () => verifyStationControlMcpToken(token) !== undefined,
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
  ) => InProcessStationControlServer;
  createInProcessStationBrowser: (
    threadId: string,
    tenantExecutionContext?: TenantExecutionContext,
  ) => InProcessStationControlServer;
  revokeStationControlCallerToken: (threadId: string) => void;
} {
  return {
    createInProcessStationControl: (threadId, tenantExecutionContext) =>
      createInProcessServer({
        sessionId: threadId,
        ...(tenantExecutionContext ? { tenantExecutionContext } : {}),
        resolveRecord: (sessionId) => resolveRecord()?.(sessionId),
        createServer: (createServer ?? createStationControlMcpServer) as never,
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
