import { Hono } from 'hono';
import { z } from 'zod';
import {
  ENGINE_OAUTH_PROXY_PATH,
  EngineMcpNeedsSignInError,
  engineMcpProxyBinding,
} from '../../services/plugins/engine-mcp-oauth.js';
import {
  ConnectAccountRequiredError,
  ToolServerOAuthUnavailableError,
} from '../../services/plugins/tool-server-oauth.js';

const negotiationRefusal = z.object({
  error: z.object({
    code: z.literal(-32022),
    data: z.object({
      supported: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(32),
    }),
  }),
});

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_NEGOTIATION_BYTES = 64 * 1024;

class ProxyBodyLimitError extends Error {}

async function boundedText(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ProxyBodyLimitError();
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

const securityHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

/** An endpoint event is the only remote URL that may become an SSE message target. */
function rewriteSse(
  body: ReadableStream<Uint8Array>,
  rewriteEndpoint: (value: string) => string,
): ReadableStream<Uint8Array> {
  let pending = '';
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const frame = (value: string) => {
    if (!/^event:\s*endpoint\s*$/m.test(value)) return value;
    return value.replace(
      /^data:\s*(.+)$/m,
      (_, endpoint: string) => `data: ${rewriteEndpoint(endpoint)}`,
    );
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending = (pending + decoder.decode(chunk, { stream: true })).replace(
          /\r\n/g,
          '\n',
        );
        let end = pending.indexOf('\n\n');
        while (end !== -1) {
          controller.enqueue(
            encoder.encode(`${frame(pending.slice(0, end))}\n\n`),
          );
          pending = pending.slice(end + 2);
          end = pending.indexOf('\n\n');
        }
        if (pending.length > 8 * 1024 * 1024)
          throw new Error('MCP event exceeds proxy limit');
      },
      flush(controller) {
        if (pending)
          controller.enqueue(encoder.encode(frame(pending + decoder.decode())));
      },
    }),
  );
}

export function createEngineOAuthProxyRoutes(): Hono {
  const app = new Hono();
  const handler = async (c: import('hono').Context) => {
    const address = c.env?.incoming?.socket?.remoteAddress;
    if (
      typeof address !== 'string' ||
      !/^(?:127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+|::1|0:0:0:0:0:0:0:1)$/i.test(
        address,
      )
    )
      return c.text('Not found', 404, securityHeaders);
    const { serverId, sessionId } = c.req.param();
    const url = new URL(c.req.url);
    const candidate =
      url.searchParams.get('token') ??
      /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    const binding = engineMcpProxyBinding(candidate, sessionId!, serverId!);
    if (!binding) return c.text('Unauthorized', 401, securityHeaders);
    const isCurrent = async () => {
      const token = await binding.current();
      if (engineMcpProxyBinding(candidate, sessionId!, serverId!) !== binding)
        throw new Error('MCP proxy credential revoked');
      return token;
    };
    let body: string | undefined;
    try {
      body = ['GET', 'HEAD'].includes(c.req.method)
        ? undefined
        : await boundedText(c.req.raw.body, MAX_REQUEST_BYTES);
    } catch (error) {
      if (error instanceof ProxyBodyLimitError)
        return c.text('MCP request exceeds proxy limit', 413, securityHeaders);
      throw error;
    }
    let rpc: { id?: unknown; method?: string } = {};
    try {
      if (body) {
        const parsed: unknown = JSON.parse(body);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          return c.text('Invalid MCP request', 400, securityHeaders);
        rpc = {
          id: 'id' in parsed ? parsed.id : undefined,
          method:
            'method' in parsed && typeof parsed.method === 'string'
              ? parsed.method
              : undefined,
        };
      }
    } catch {
      return c.text('Invalid MCP request', 400, securityHeaders);
    }
    const failure = (message: string, status = 502, headers = {}) =>
      Response.json(
        {
          jsonrpc: '2.0',
          id: rpc.id ?? null,
          error: { code: -32001, message },
        },
        { status, headers: { ...securityHeaders, ...headers } },
      );
    let remoteStatus: number | undefined;
    try {
      const messageRoute = c.req.path.endsWith('/messages');
      const target = messageRoute ? binding.messageEndpoint : binding.endpoint;
      if (!target) return c.text('Not found', 404, securityHeaders);
      const headers = new Headers();
      for (const [name, value] of c.req.raw.headers) {
        if (
          ['accept', 'content-type', 'last-event-id'].includes(name) ||
          name.startsWith('mcp-')
        )
          headers.set(name, value);
      }
      let token: string;
      try {
        token = await binding.accessToken();
      } catch (error) {
        if (!(error instanceof ConnectAccountRequiredError)) throw error;
        await binding.needsSignIn();
        return failure(
          `Integration '${serverId}' needs sign-in. Open Connections → Tools and sign in to its account.`,
          401,
        );
      }
      const send = async () => {
        token = await isCurrent();
        headers.set('authorization', `Bearer ${token}`);
        return fetch(target, {
          method: c.req.method,
          headers,
          body,
          redirect: 'error',
          signal: AbortSignal.any([
            c.req.raw.signal,
            binding.signal,
            AbortSignal.timeout(Math.max(1, binding.expiresAt - Date.now())),
          ]),
        });
      };
      let response = await send();
      if (response.status === 401) {
        await response.body?.cancel();
        try {
          token = await binding.accessToken(token);
        } catch (error) {
          if (!(error instanceof ConnectAccountRequiredError)) throw error;
          await binding.needsSignIn();
          return failure(
            `Integration '${serverId}' needs sign-in. Open Connections → Tools and sign in to its account.`,
            401,
          );
        }
        response = await send();
        if (response.status === 401) {
          await response.body?.cancel();
          await binding.needsSignIn(token);
          return failure(
            `Integration '${serverId}' needs sign-in. Open Connections → Tools and sign in to its account.`,
            401,
          );
        }
      }
      remoteStatus = response.status;
      if (response.status === 400) {
        // Preserve only the SDK's protocol-negotiation data, never remote error prose.
        const refusal = negotiationRefusal.safeParse(
          await boundedText(response.body, MAX_NEGOTIATION_BYTES)
            .then((text) => JSON.parse(text))
            .catch((error) => {
              if (error instanceof ProxyBodyLimitError) throw error;
              return undefined;
            }),
        );
        if (refusal.success) {
          return c.json(
            {
              jsonrpc: '2.0',
              id: rpc.id ?? null,
              error: {
                code: -32022,
                message: 'Unsupported MCP protocol version',
                data: {
                  supported: refusal.data.error.data.supported,
                },
              },
            },
            400,
            securityHeaders,
          );
        }
      }
      if (!response.ok) {
        await response.body?.cancel();
        const allow = response.headers.get('allow');
        return failure(
          'Remote MCP request failed.',
          response.status,
          allow ? { Allow: allow } : {},
        );
      }
      await isCurrent();
      const outgoing = new Headers(securityHeaders);
      for (const [name, value] of response.headers) {
        if (name === 'content-type' || name.startsWith('mcp-'))
          outgoing.set(name, value);
      }
      let stream = response.body;
      if (
        stream &&
        response.headers.get('content-type')?.includes('text/event-stream')
      ) {
        stream = rewriteSse(stream, (value) => {
          const messageEndpoint = new URL(value, binding.endpoint);
          if (
            messageEndpoint.origin !== new URL(binding.endpoint).origin ||
            messageEndpoint.username ||
            messageEndpoint.password
          )
            throw new Error('Invalid MCP message endpoint');
          binding.messageEndpoint = messageEndpoint.href;
          const local = new URL(c.req.url);
          local.pathname = `${ENGINE_OAUTH_PROXY_PATH}/${encodeURIComponent(serverId!)}/${encodeURIComponent(sessionId!)}/messages`;
          return local.href;
        });
      }
      return new Response(stream, {
        status: response.status,
        headers: outgoing,
      });
    } catch (error) {
      if (error instanceof ProxyBodyLimitError)
        return failure('Remote MCP request failed.', remoteStatus ?? 502);
      if (error instanceof ToolServerOAuthUnavailableError)
        return failure(error.message, 503);
      if (error instanceof EngineMcpNeedsSignInError) {
        await binding.needsSignIn();
        return failure(error.message, 401);
      }
      return failure(
        'MCP proxy connection is unavailable. Start the session again if the integration changed.',
      );
    }
  };
  // Literal paths keep both leaves visible to the pairing-scope scanner.
  app.all('/mcp/oauth-proxy/:serverId/:sessionId', handler);
  app.all('/mcp/oauth-proxy/:serverId/:sessionId/messages', handler);
  return app;
}
