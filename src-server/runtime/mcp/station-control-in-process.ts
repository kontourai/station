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
 * Mint this session's `sdk-in-process` token and build its server. The
 * caller revokes the token with `revokeStationControlMcpToken(sessionId)`
 * when the session stops, exactly as for every other channel.
 */
function createInProcessStationControlServer(input: {
  sessionId: string;
  tenantExecutionContext?: TenantExecutionContext;
  resolveRecord?: StationControlCallerRecordResolver;
  /** Test seam: production serves the real registrations. */
  createServer?: typeof createStationControlMcpServer;
}): InProcessStationControlServer {
  const { token } = mintStationControlMcpToken(
    input.sessionId,
    'sdk-in-process',
    undefined,
    input.tenantExecutionContext,
  );
  const server = (input.createServer ?? createStationControlMcpServer)();
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
): {
  createInProcessStationControl: (
    threadId: string,
    tenantExecutionContext?: TenantExecutionContext,
  ) => InProcessStationControlServer;
  revokeStationControlCallerToken: (threadId: string) => void;
} {
  return {
    createInProcessStationControl: (threadId, tenantExecutionContext) =>
      createInProcessStationControlServer({
        sessionId: threadId,
        ...(tenantExecutionContext ? { tenantExecutionContext } : {}),
        resolveRecord: (sessionId) => resolveRecord()?.(sessionId),
        ...(createServer ? { createServer } : {}),
      }),
    revokeStationControlCallerToken: (threadId) =>
      revokeStationControlMcpToken(threadId),
  };
}
