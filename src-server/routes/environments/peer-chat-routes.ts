import { Hono } from 'hono';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import type { FeaturePreviewSelector } from '../../services/feature-previews/feature-preview-registry.js';
import type { PeerCredentialStore } from '../../services/peers/peer-credential-store.js';
import {
  fetchRemoteStation,
  RELAYED_RESPONSE_HEADER,
  type RemoteStationForwarder,
} from '../../services/remote-stations/remote-station-forwarder.js';
import {
  foregroundMessageObjectSchema,
  orchestrationCommandSchema,
} from '../orchestration/orchestration.js';

// Only foreground chat operations. In particular, neither delegation nor
// peer administration can turn this bridge into an onward credential hop.
const reads = [
  /^\/api\/projects$/,
  /^\/api\/orchestration\/sessions\/[^/]+$/,
  /^\/api\/orchestration\/sessions\/[^/]+\/(?:content\/[^/]+|requests\/[^/]+(?:\/content-binding)?|child-work\/[^/]+\/(?:transcript|instructions))$/,
  /^\/api\/orchestration\/conversations\/[^/]+\/event-window$/,
];
const writes = [
  /^\/api\/orchestration\/chat$/,
  /^\/api\/orchestration\/commands$/,
];

export function createPeerChatRoutes(deps: {
  peers: Pick<PeerCredentialStore, 'get'>;
  remote: RemoteStationForwarder;
  preview?: FeaturePreviewSelector;
  current: (request: Request) => boolean;
}) {
  const app = new Hono();
  app.all('/:environmentId/chat-api/*', async (c) => {
    const request = c.req.raw;
    if (requestMayBeAnAgent(request) || !deps.current(request))
      return c.json({ success: false, error: 'Forbidden' }, 403);
    if (!deps.preview?.select({ enabled: () => true, disabled: () => false }))
      return c.json(
        {
          success: false,
          error:
            'Enable Paired Station chats in Settings → Advanced → Feature previews.',
          code: 'feature_preview_disabled',
          previewId: 'paired-station-chats',
          settingsPath:
            '/settings?view=feature-previews&highlight=feature-previews',
        },
        404,
      );
    const url = new URL(request.url);
    const path = `/${url.pathname.split('/chat-api/')[1] ?? ''}`;
    const patterns =
      request.method === 'GET'
        ? reads
        : request.method === 'POST'
          ? writes
          : [];
    try {
      if (
        !patterns.some((pattern) => pattern.test(path)) ||
        path
          .split('/')
          .some(
            (part) =>
              /[\\/%]/.test(decodeURIComponent(part)) ||
              ['.', '..'].includes(decodeURIComponent(part)),
          ) ||
        url.search.length > 4096
      )
        return c.json(
          { success: false, error: 'Chat operation unavailable' },
          404,
        );
    } catch {
      return c.json({ success: false, error: 'Invalid chat operation' }, 400);
    }
    if (
      /^\/api\/orchestration\/sessions\/[^/]+$/.test(path) &&
      url.searchParams.get('view') !== 'window-v1'
    )
      return c.json(
        { success: false, error: 'Use bounded conversation history.' },
        400,
      );
    let body: string | undefined;
    if (request.method === 'POST') {
      const bounded = await readBoundedRequestBody(request, 1024 * 1024);
      if (bounded.status !== 'ok')
        return c.json({ success: false, error: 'Invalid chat request' }, 400);
      body = bounded.body;
      if (path === '/api/orchestration/commands') {
        try {
          const command = orchestrationCommandSchema.safeParse(
            JSON.parse(body),
          );
          if (
            !command.success ||
            !['interruptTurn', 'respondToRequest'].includes(command.data.type)
          )
            return c.json(
              { success: false, error: 'Chat command unavailable' },
              400,
            );
          body = JSON.stringify(command.data);
        } catch {
          return c.json({ success: false, error: 'Invalid chat command' }, 400);
        }
      }
      if (path === '/api/orchestration/chat') {
        let parsed: ReturnType<typeof foregroundMessageObjectSchema.safeParse>;
        try {
          parsed = foregroundMessageObjectSchema.safeParse(JSON.parse(body));
        } catch {
          return c.json({ success: false, error: 'Invalid chat request' }, 400);
        }
        if (
          !parsed.success ||
          parsed.data.target.environment?.kind !== 'current' ||
          (parsed.data.target.workspace &&
            (parsed.data.target.workspace.kind !== 'project' ||
              parsed.data.target.workspace.cwd !== undefined))
        )
          return c.json(
            {
              success: false,
              error: 'Choose a project on the selected Station.',
            },
            400,
          );
        // Forward the receiver's foreground schema, never caller-authored
        // delegation, actor, preparation, or background-execution fields.
        body = JSON.stringify(parsed.data);
      }
    }
    try {
      const id = c.req.param('environmentId');
      const peer = deps.peers.get(id);
      if (!peer)
        return c.json(
          { success: false, error: 'Paired Station unavailable' },
          404,
        );
      const target = await deps.remote.resolve(id);
      const current = () => {
        const now = deps.peers.get(id);
        return (
          deps.current(request) &&
          deps.preview?.select({
            enabled: () => true,
            disabled: () => false,
          }) === true &&
          !request.signal.aborted &&
          now?.apiBase === peer.apiBase &&
          now.credential === peer.credential
        );
      };
      if (
        target.kind !== 'peer' ||
        target.apiBase !== peer.apiBase ||
        target.requestOptions.headers.Authorization !==
          `Bearer ${peer.credential}` ||
        !current()
      )
        return c.json(
          { success: false, error: 'Reconnect to the paired Station.' },
          409,
        );
      const handshake = await fetchRemoteStation(
        `${target.apiBase}/.well-known/station/v1`,
        {
          headers: target.requestOptions.headers,
          signal: request.signal,
          redirect: 'error',
        },
        target.requestOptions.timeoutMs,
      );
      const identity: unknown = await handshake.json();
      if (
        !handshake.ok ||
        !identity ||
        typeof identity !== 'object' ||
        !('environmentId' in identity) ||
        identity.environmentId !== id ||
        !current()
      )
        return c.json(
          {
            success: false,
            error:
              'The paired Station did not confirm its identity. Reconnect before continuing.',
          },
          409,
        );
      const response = await fetchRemoteStation(
        `${target.apiBase}${path}${url.search}`,
        {
          method: request.method,
          headers: {
            ...target.requestOptions.headers,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body,
          signal: request.signal,
          redirect: 'error',
        },
        target.requestOptions.timeoutMs,
      );
      if (!current())
        return c.json(
          {
            success: false,
            error: 'Station access changed. Reconnect before continuing.',
          },
          409,
        );
      // No remote cookies, redirects, or credentials are published to the
      // browser. Preserve relay attribution for the envelope middleware.
      return new Response(response.body, {
        status: response.status,
        headers: {
          'Content-Type': path.includes('/content/')
            ? 'text/plain; charset=utf-8'
            : 'application/json; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          ...Object.fromEntries(
            [
              'X-Station-Content-Kind',
              'X-Station-Content-Bytes',
              'X-Station-Content-Complete',
            ].flatMap((name) => {
              const value = response.headers.get(name);
              return value === null ? [] : [[name, value]];
            }),
          ),
          'Cache-Control': 'no-store',
          [RELAYED_RESPONSE_HEADER]: '1',
        },
      });
    } catch {
      if (request.method === 'POST') c.header(RELAYED_RESPONSE_HEADER, '1');
      return c.json(
        {
          success: false,
          error:
            request.method === 'POST'
              ? 'The Station did not confirm this change. Check the conversation before sending again.'
              : 'Could not reach the paired Station. Reconnect and try again.',
        },
        502,
      );
    }
  });
  return app;
}
