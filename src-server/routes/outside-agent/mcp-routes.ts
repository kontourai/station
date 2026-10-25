// UNWIRED(#4115): non-distributable R4a composition; the runtime's compiled guard remains until R6.
import { randomBytes } from 'node:crypto';
import {
  type EventStore,
  isJSONRPCRequest,
  type JSONRPCMessage,
  ProtocolError,
  parseJSONRPCMessage,
  type Server,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import { type Context, Hono } from 'hono';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import {
  type OutsideOAuthExposure,
  outsideIngress,
  validateOutsideExposure,
} from '../../security/outside-agent-ingress.js';
import { canonicalOutsideOrigin } from '../../services/outside-agent/management-service.js';
import { createOutsideMcpDispatch } from '../../services/outside-agent/mcp-dispatch.js';
import {
  MINUTE,
  type Records,
} from '../../services/outside-agent/oauth-records.js';
import type { OutsideAgentGrantStore } from '../../services/outside-agent/oauth-store.js';
import type { ProjectService } from '../../services/projects/project-service.js';
import { inspectServePort } from '../../services/tailscale/public-ingress-origin.js';
import { outsideAgentMcpOutcomes } from '../../telemetry/metrics.js';

const MAX_BYTES = 1024 * 1024;
const versions = ['2025-11-25', '2025-06-18'];
const opaque = () => randomBytes(32).toString('base64url');
type Grant = Records['grant'];
interface Session {
  id: string;
  token: string;
  grantId: string;
  familyId: string;
  version: number;
  protocol: string;
  origin?: string;
  touched: number;
  transport: WebStandardStreamableHTTPServerTransport;
  server: Server;
  abort: AbortController;
}

/** Bounded, session-local cursors. A version change destroys the session and every cursor. */
class ResumeEvents implements EventStore {
  readonly events = new Map<
    string,
    { stream: string; message: JSONRPCMessage; bytes: number }
  >();
  bytes = 0;
  async storeEvent(stream: string, message: JSONRPCMessage) {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (bytes > MAX_BYTES) throw new Error('MCP response limit');
    while (this.events.size >= 64 || this.bytes + bytes > MAX_BYTES) {
      const first = this.events.keys().next().value;
      if (!first) break;
      this.bytes -= this.events.get(first)!.bytes;
      this.events.delete(first);
    }
    const id = opaque();
    this.events.set(id, { stream, message, bytes });
    this.bytes += bytes;
    return id;
  }
  async getStreamIdForEventId(id: string) {
    return this.events.get(id)?.stream;
  }
  async replayEventsAfter(
    id: string,
    { send }: { send(id: string, message: JSONRPCMessage): Promise<void> },
  ) {
    const stream = this.events.get(id)?.stream;
    if (!stream) throw new Error('Unknown resume cursor');
    let after = false;
    for (const [key, event] of this.events) {
      if (after && event.stream === stream) await send(key, event.message);
      if (key === id) after = true;
    }
    return stream;
  }
}

/** No release runtime mounts this factory. Its ingress and grant checks are also used by isolated real-client builds. */
export async function createOutsideAgentMcpServer(input: {
  store: OutsideAgentGrantStore;
  validateGrant(grant: Grant): boolean;
  projects: Pick<ProjectService, 'listProjects' | 'getProject'>;
  exposure: OutsideOAuthExposure;
  checkServe?: () => Promise<'clear' | 'mapped' | 'unverifiable'>;
}) {
  const { store, exposure } = input;
  const issuer = validateOutsideExposure(exposure);
  if (store.options.issuer !== issuer.origin)
    throw new Error('Outside MCP issuer mismatch');
  const resource = `${issuer.origin}/mcp`;
  const now = store.options.now ?? Date.now;
  const sessions = new Map<string, Session>();
  const calls = new Map<string, number>();
  const dispatches = new Map<string, number>();
  let closed = false,
    healthy = true;
  const app = new Hono();
  const live = (token: string, origin?: string): Grant | undefined => {
    if (closed || !healthy) return undefined;
    const grant = store.access(token, resource);
    if (!grant || !input.validateGrant(grant)) return undefined;
    if (
      origin &&
      !store
        .policy('cors')
        .origins.includes(canonicalOutsideOrigin(origin).serializedOrigin)
    )
      return undefined;
    return grant;
  };
  const terminate = (session: Session) => {
    sessions.delete(session.id);
    session.abort.abort();
    void session.server.close().catch(() => {});
  };
  const current = (session: Session): Grant => {
    const grant = live(session.token, session.origin);
    if (
      !grant ||
      grant.id !== session.grantId ||
      grant.familyId !== session.familyId ||
      grant.version !== session.version ||
      session.touched + 30 * MINUTE <= now()
    ) {
      terminate(session);
      throw new Error('Outside MCP session ended');
    }
    return grant;
  };
  const recheck = () => {
    for (const session of [...sessions.values()]) {
      try {
        current(session);
      } catch {
        terminate(session);
      }
    }
  };
  const checkServe =
    input.checkServe ??
    (() =>
      inspectServePort(
        Number(issuer.port || (issuer.protocol === 'http:' ? 80 : 443)),
      ));
  const verifyServe = async () => {
    if (issuer.protocol !== 'http:') return;
    try {
      healthy = (await checkServe()) === 'clear';
    } catch {
      healthy = false;
    }
    if (!healthy) recheck();
  };
  await verifyServe();
  if (!healthy)
    throw new Error(
      'Outside MCP refused: Tailscale Serve mapped or unverifiable',
    );
  const serveTimer = setInterval(() => {
    void verifyServe();
  }, 30_000);
  // Cross-process changes and authority loss are read from the authoritative store; no positive auth cache.
  const stateTimer = setInterval(recheck, 1000);
  serveTimer.unref();
  stateTimer.unref();
  const unsubscribe = store.onRequestChange(recheck);

  const challenge = (c: Context) => {
    outsideAgentMcpOutcomes.add(1, { outcome: 'authentication-refused' });
    c.header(
      'WWW-Authenticate',
      `Bearer resource_metadata="${issuer.origin}/.well-known/oauth-protected-resource/mcp", scope="station-control:read"`,
    );
    return c.json({ error: 'invalid_token' }, 401);
  };
  const rpcError = (
    c: Context,
    status: 400 | 404 | 413 | 429,
    code: number,
    message: string,
  ) => c.json({ jsonrpc: '2.0', id: null, error: { code, message } }, status);

  /** Pull with no read-ahead. Check + enqueue share BEGIN IMMEDIATE with revoke/change across processes. */
  const guardEmission = (
    response: Response,
    session: Session,
    token: string,
  ): Response => {
    if (!response.body) return response;
    const reader = response.body.getReader();
    let ended = false;
    const stop = () => {
      if (!ended) {
        ended = true;
        session.abort.signal.removeEventListener('abort', stop);
        void reader.cancel().catch(() => {});
      }
    };
    session.abort.signal.addEventListener('abort', stop, { once: true });
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done || ended) {
              ended = true;
              session.abort.signal.removeEventListener('abort', stop);
              controller.close();
              return;
            }
            if (next.value.byteLength > MAX_BYTES)
              throw new Error('MCP response limit');
            store.decide(() => {
              current(session);
              const grant = live(token, session.origin);
              if (!grant || grant.version !== session.version)
                throw new Error('Outside MCP stream ended');
              controller.enqueue(next.value);
            });
          } catch {
            terminate(session);
            controller.close();
          } finally {
            if (ended) session.abort.signal.removeEventListener('abort', stop);
          }
        },
        cancel() {
          stop();
          session.abort.signal.removeEventListener('abort', stop);
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  };

  const handler = async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    if (closed || !healthy || exposure.hosted) return c.notFound();
    if (!outsideIngress(c, exposure)) return c.notFound();
    try {
      const origin = c.req.header('origin');
      if (origin !== undefined) {
        let canonical: string;
        try {
          canonical = canonicalOutsideOrigin(origin).serializedOrigin;
        } catch {
          return c.body(null, 403);
        }
        if (!store.policy('cors').origins.includes(canonical))
          return c.body(null, 403);
        c.header('Access-Control-Allow-Origin', origin);
        c.header('Vary', 'Origin');
        c.header(
          'Access-Control-Expose-Headers',
          'Mcp-Session-Id, MCP-Protocol-Version, WWW-Authenticate',
        );
      }
      if (c.req.method === 'OPTIONS') {
        const headers = (c.req.header('access-control-request-headers') ?? '')
          .toLowerCase()
          .split(',')
          .map((s) => s.trim());
        if (
          !origin ||
          !['GET', 'POST', 'DELETE'].includes(
            c.req.header('access-control-request-method') ?? '',
          ) ||
          headers.some(
            (s) =>
              s &&
              ![
                'authorization',
                'content-type',
                'mcp-session-id',
                'mcp-protocol-version',
                'last-event-id',
              ].includes(s),
          )
        )
          return c.body(null, 403);
        c.header('Access-Control-Allow-Methods', 'GET, POST, DELETE');
        c.header(
          'Access-Control-Allow-Headers',
          'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
        );
        return c.body(null, 204);
      }
      const candidate = /^Bearer (oat_[A-Za-z0-9_-]{43})$/.exec(
        c.req.header('authorization') ?? '',
      )?.[1];
      if (!candidate || new URL(c.req.url).search) return challenge(c);
      const grant = live(candidate, origin);
      if (!grant) return challenge(c);
      // Authenticate before method/session handling, including anonymous GET before initialize.
      if (!['POST', 'GET', 'DELETE'].includes(c.req.method)) {
        c.header('Allow', 'GET, POST, DELETE, OPTIONS');
        return c.body(null, 405);
      }
      const sessionId = c.req.header('mcp-session-id');
      let session = sessionId ? sessions.get(sessionId) : undefined;
      if (
        sessionId &&
        (!session ||
          session.grantId !== grant.id ||
          session.familyId !== grant.familyId ||
          session.origin !== origin)
      )
        return rpcError(c, 404, -32001, 'Session not found');
      if (session) {
        session.token = candidate;
        try {
          current(session);
        } catch {
          return rpcError(c, 404, -32001, 'Session not found');
        }
        const version = c.req.header('mcp-protocol-version') ?? '2025-03-26';
        if (version !== session.protocol)
          return rpcError(
            c,
            400,
            -32600,
            'MCP-Protocol-Version must match the negotiated version',
          );
      }
      let parsedBody: unknown;
      if (c.req.method === 'POST') {
        if ((calls.get(grant.id) ?? 0) >= 10) {
          c.header('Retry-After', '1');
          return rpcError(c, 429, -32000, 'MCP call capacity');
        }
        calls.set(grant.id, (calls.get(grant.id) ?? 0) + 1);
        try {
          const body = await readBoundedRequestBody(c.req.raw, MAX_BYTES);
          if (body.status !== 'ok')
            return rpcError(
              c,
              body.status === 'too-large' ? 413 : 400,
              -32600,
              'Invalid MCP body',
            );
          try {
            parsedBody = JSON.parse(body.body);
          } catch {
            return rpcError(c, 400, -32700, 'Parse error');
          }
          if (Array.isArray(parsedBody))
            return rpcError(c, 400, -32600, 'MCP batches are unsupported');
          if (!session) {
            let message: JSONRPCMessage;
            try {
              message = parseJSONRPCMessage(parsedBody);
            } catch {
              return rpcError(c, 400, -32600, 'Invalid MCP message');
            }
            if (
              isJSONRPCRequest(message) &&
              !['initialize', 'ping', 'tools/list', 'tools/call'].includes(
                message.method,
              )
            ) {
              const id = message.id;
              return store.decide(() =>
                live(candidate, origin)
                  ? c.json(
                      {
                        jsonrpc: '2.0',
                        id,
                        error: { code: -32601, message: 'Method not found' },
                      },
                      200,
                    )
                  : challenge(c),
              );
            }
            if (!isJSONRPCRequest(message) || message.method !== 'initialize')
              return rpcError(c, 400, -32000, 'Initialize required');
            const protocol = message.params?.protocolVersion;
            if (typeof protocol !== 'string' || !versions.includes(protocol))
              return rpcError(
                c,
                400,
                -32602,
                'Unsupported MCP protocol version',
              );
            if (
              [...sessions.values()].filter((s) => s.grantId === grant.id)
                .length >= 5
            ) {
              c.header('Retry-After', '1');
              return rpcError(c, 429, -32000, 'MCP session capacity');
            }
            const id = opaque();
            const transport = new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: () => id,
              maxRequestBodySize: MAX_BYTES,
              eventStore: new ResumeEvents(),
              keepAliveMs: 0,
              // Native clients advertise both; choose JSON when requested without an SSE preference.
              enableJsonResponse:
                c.req.header('accept')?.startsWith('application/json') === true,
            });
            const owned: Session = {
              id,
              token: candidate,
              grantId: grant.id,
              familyId: grant.familyId,
              version: grant.version,
              protocol,
              origin,
              touched: now(),
              transport,
              server: createOutsideMcpDispatch({
                current: () => current(owned),
                projects: input.projects,
                reserveCall: () => {
                  const count = dispatches.get(grant.id) ?? 0;
                  if (count >= 10)
                    throw new ProtocolError(-32000, 'MCP call capacity');
                  dispatches.set(grant.id, count + 1);
                  return () => {
                    const remaining = (dispatches.get(grant.id) ?? 1) - 1;
                    if (remaining) dispatches.set(grant.id, remaining);
                    else dispatches.delete(grant.id);
                  };
                },
              }),
              abort: new AbortController(),
            };
            session = owned;
            sessions.set(id, owned);
            owned.server.onclose = () => {
              sessions.delete(id);
              owned.abort.abort();
            };
            await owned.server.connect(transport);
          }
          current(session);
          session.touched = now();
          const response = await session.transport.handleRequest(c.req.raw, {
            parsedBody,
          });
          return guardEmission(response, session, candidate);
        } finally {
          const count = (calls.get(grant.id) ?? 1) - 1;
          if (count) calls.set(grant.id, count);
          else calls.delete(grant.id);
        }
      }
      if (!session) return rpcError(c, 400, -32000, 'Session required');
      session.touched = now();
      const response = await session.transport.handleRequest(c.req.raw);
      if (c.req.method === 'DELETE') {
        terminate(session);
        return response;
      }
      return guardEmission(response, session, candidate);
    } catch {
      outsideAgentMcpOutcomes.add(1, { outcome: 'unavailable' });
      return c.json({ error: 'temporarily_unavailable' }, 503);
    }
  };
  // Literal exact leaves are also declared in pairing-route-scopes.ts. Never mount /mcp/* here.
  app.get('/mcp', handler);
  app.post('/mcp', handler);
  app.delete('/mcp', handler);
  app.options('/mcp', handler);
  app.all('/mcp', handler);
  return {
    app,
    close() {
      closed = true;
      clearInterval(serveTimer);
      clearInterval(stateTimer);
      unsubscribe();
      for (const s of [...sessions.values()]) terminate(s);
    },
  };
}
