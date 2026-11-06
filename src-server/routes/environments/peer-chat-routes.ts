import { isAuthorityObservation } from '@kontourai/station-contracts/authority-observation';
import { CHAT_ATTACHMENT_MAX_BYTES } from '@kontourai/station-contracts/chat-attachment';
import {
  CLIENT_PROTOCOL_HEADER,
  STATION_COMPAT_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import {
  STATION_ENVELOPE_HEADER,
  STATION_ENVELOPE_HEADER_VALUE,
} from '@kontourai/station-contracts/http';
import {
  PEER_CHAT_PRE_EFFECT_CODES,
  PEER_CHAT_REFUSAL_CODE,
  PEER_CHAT_UPLOAD_GRANT_HEADER,
  type PeerChatConnectionV1,
  type PeerChatTargetRefusalV1,
} from '@kontourai/station-contracts/peer-chat';
import { type Context, Hono } from 'hono';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import type { FeaturePreviewSelector } from '../../services/feature-previews/feature-preview-registry.js';
import type { PeerCredentialStore } from '../../services/peers/peer-credential-store.js';
import { guardProjectResponse } from '../../services/projects/project-response-guard.js';
import {
  fetchRemoteStationBytes,
  RELAYED_RESPONSE_HEADER,
  type RemoteStationForwarder,
  streamRemoteStation,
} from '../../services/remote-stations/remote-station-forwarder.js';
import {
  classifyPeerChatOperation,
  transformPeerChatBody,
} from './peer-chat-policy.js';

export function createPeerChatRoutes(deps: {
  peers: Pick<PeerCredentialStore, 'get'>;
  remote: RemoteStationForwarder;
  preview?: FeaturePreviewSelector;
  current: (request: Request) => boolean;
  owner: (request: Request) => boolean;
  previewGeneration?: () => number;
}) {
  const app = new Hono();
  app.all('/:environmentId/chat-connection', handle);
  app.all('/:environmentId/chat-api/*', handle);

  async function handle(c: Context) {
    const request = c.req.raw;
    const previewGeneration = deps.previewGeneration?.();
    if (
      requestMayBeAnAgent(request) ||
      !deps.current(request) ||
      !deps.owner(request)
    )
      return c.json({ success: false, error: 'Forbidden' }, 403);
    const previewEnabled = () =>
      deps.preview?.select({ enabled: () => true, disabled: () => false }) ===
      true;
    if (!previewEnabled())
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
    const descriptor = url.pathname.endsWith('/chat-connection');
    const operation = descriptor
      ? null
      : classifyPeerChatOperation(
          request.method,
          `/${url.pathname.split('/chat-api/')[1] ?? ''}`,
          url.search,
        );
    if (descriptor ? request.method !== 'GET' || url.search !== '' : !operation)
      return c.json(
        { success: false, error: 'Chat operation unavailable' },
        404,
      );
    let body: string | undefined;
    let mutationKey: string | undefined;
    if (operation?.body) {
      const bounded =
        operation.body === 'empty' && !request.body
          ? { status: 'ok' as const, body: '' }
          : await readBoundedRequestBody(request, operation.maxBodyBytes);
      if (bounded.status !== 'ok')
        return c.json({ success: false, error: 'Invalid chat request' }, 400);
      const transformed = await transformPeerChatBody(
        operation.body,
        bounded.body,
      );
      if (!transformed)
        return c.json({ success: false, error: 'Invalid chat request' }, 400);
      ({ body, mutationKey } = transformed);
    }
    const uploadGrant = request.headers.get(PEER_CHAT_UPLOAD_GRANT_HEADER);
    if (
      (operation?.body === 'upload' &&
        !/^[A-Za-z0-9_-]{43}$/.test(uploadGrant ?? '')) ||
      (uploadGrant !== null && operation?.body !== 'upload')
    )
      return c.json(
        { success: false, error: 'Invalid attachment upload authority' },
        400,
      );
    let forwarded = false;
    try {
      const id = c.req.param('environmentId')!;
      const peer = deps.peers.get(id);
      if (!peer)
        return c.json(
          { success: false, error: 'Paired Station unavailable' },
          404,
        );
      const current = () => {
        const now = deps.peers.get(id);
        return (
          deps.current(request) &&
          deps.owner(request) &&
          previewEnabled() &&
          deps.previewGeneration?.() === previewGeneration &&
          !request.signal.aborted &&
          now?.environmentId === id &&
          now.apiBase === peer.apiBase &&
          now.credential === peer.credential &&
          now.updatedAt === peer.updatedAt
        );
      };
      const target = await deps.remote.resolve(id);
      if (
        target.kind !== 'peer' ||
        target.environmentId !== id ||
        target.apiBase !== peer.apiBase ||
        target.requestOptions.headers.Authorization !==
          `Bearer ${peer.credential}` ||
        !current()
      )
        return c.json(
          { success: false, error: 'Reconnect to the paired Station.' },
          409,
        );
      const refuseTarget = (
        remoteStatus: PeerChatTargetRefusalV1['remoteStatus'],
        refusalCode?: PeerChatTargetRefusalV1['refusalCode'],
      ) =>
        c.json(
          {
            success: false,
            code: PEER_CHAT_REFUSAL_CODE,
            error:
              remoteStatus === 409
                ? 'The paired Station refused this change. Review the conversation before trying again.'
                : remoteStatus === 401
                  ? 'Reconnect to the paired Station.'
                  : 'This connection cannot perform that operation on the paired Station.',
            details: {
              version: 1,
              failureAuthority: 'target',
              environmentId: id,
              remoteStatus,
              disposition: 'refused-before-dispatch',
              ...(refusalCode ? { refusalCode } : {}),
              ...(mutationKey === undefined ? {} : { mutationKey }),
            },
          },
          424,
        );
      const handshake = await fetchRemoteStationBytes(
        `${target.apiBase}/.well-known/station/v1`,
        {
          headers: target.requestOptions.headers,
          signal: request.signal,
        },
        target.requestOptions.timeoutMs,
        current,
        64 * 1024,
      );
      if (handshake.status === 401 || handshake.status === 403)
        return refuseTarget(handshake.status);
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
      const flags =
        'capabilities' in identity &&
        identity.capabilities &&
        typeof identity.capabilities === 'object'
          ? identity.capabilities
          : {};
      const localConversation =
        'delegationLocalConversationV1' in flags &&
        flags.delegationLocalConversationV1 === true;
      if (descriptor) {
        const authorityReply = await fetchRemoteStationBytes(
          `${target.apiBase}/api/auth/authority`,
          { headers: target.requestOptions.headers, signal: request.signal },
          target.requestOptions.timeoutMs,
          current,
          64 * 1024,
        );
        if (authorityReply.status === 401 || authorityReply.status === 403)
          return refuseTarget(authorityReply.status);
        const authority: unknown = await authorityReply.json();
        if (
          !authorityReply.ok ||
          !isAuthorityObservation(authority) ||
          authority.environmentId !== id ||
          !current()
        )
          return c.json(
            {
              success: false,
              error:
                'The paired Station did not confirm its conversation authority.',
            },
            409,
          );
        // Receiver identity survives S restarts and never derives public keys from a bearer.
        const principalNamespace = JSON.stringify([
          authority.environmentId,
          authority.principal.kind,
          authority.principal.id,
          authority.grant.kind === 'device'
            ? authority.grant.deviceId
            : authority.grant.kind,
        ]);
        const grant = authority.grant;
        const scopes = peer.scope
          .split(' ')
          .filter(
            (scope) =>
              grant.kind === 'operator' || grant.grantedScopes.includes(scope),
          );
        const result: PeerChatConnectionV1 = {
          version: 1,
          environmentId: id,
          stationName: peer.label ?? target.environmentName,
          principalNamespace,
          receiver: { delegationLocalConversationV1: localConversation },
          ceiling: {
            read: scopes.includes('orchestration:read'),
            operate: scopes.includes('orchestration:operate'),
            localConversation,
          },
        };
        return c.json({ success: true, data: result });
      }
      if (
        !operation ||
        (operation.requiresLocalConversation && !localConversation)
      )
        return c.json(
          {
            success: false,
            error: 'Update the paired Station to use this operation.',
          },
          409,
        );
      const headers = new Headers(target.requestOptions.headers);
      headers.set(
        CLIENT_PROTOCOL_HEADER,
        String(STATION_COMPAT_PROTOCOL_VERSION),
      );
      for (const name of [
        'Accept',
        'Last-Event-ID',
        'X-Station-Client-Session',
        'X-Station-Stream-Epoch',
      ]) {
        const value = request.headers.get(name);
        if (
          value &&
          value.length <= 2048 &&
          [...value].every((character) => character.charCodeAt(0) >= 32)
        )
          headers.set(name, value);
      }
      if (body !== undefined)
        headers.set(
          'Content-Type',
          operation.body === 'upload'
            ? 'text/plain;charset=utf-8'
            : 'application/json',
        );
      if (operation.body === 'upload') {
        headers.set('Authorization', `Bearer ${uploadGrant}`);
        headers.set(
          'Content-Length',
          String(Buffer.byteLength(body ?? '', 'utf8')),
        );
      }
      if (!current())
        return c.json(
          { success: false, error: 'Station access changed.' },
          409,
        );
      forwarded = true;
      const remoteUrl = `${target.apiBase}${operation.path}${operation.query}`;
      const init: RequestInit = {
        method: request.method,
        headers,
        body,
        signal: request.signal,
      };
      let response =
        operation.response === 'events'
          ? await streamRemoteStation(
              remoteUrl,
              init,
              target.requestOptions.timeoutMs,
              current,
            )
          : await fetchRemoteStationBytes(
              remoteUrl,
              init,
              target.requestOptions.timeoutMs,
              current,
              operation.response === 'media'
                ? CHAT_ATTACHMENT_MAX_BYTES
                : 22 * 1024 * 1024,
            );
      if (!current()) {
        void response.body?.cancel().catch(() => {});
        return c.json(
          {
            success: false,
            error: operation.mutation
              ? 'The Station did not confirm this change. Check the conversation before sending again.'
              : 'Station access changed. Reconnect before continuing.',
          },
          409,
        );
      }
      if (response.status === 401 || response.status === 403) {
        void response.body?.cancel().catch(() => {});
        return refuseTarget(response.status);
      }
      if (
        operation.mutation &&
        response.status === 409 &&
        response.headers.get(STATION_ENVELOPE_HEADER) ===
          STATION_ENVELOPE_HEADER_VALUE
      ) {
        const rejected: unknown = await response
          .clone()
          .json()
          .catch(() => null);
        if (
          rejected &&
          typeof rejected === 'object' &&
          'success' in rejected &&
          rejected.success === false &&
          'code' in rejected &&
          (!('outcome' in rejected) || rejected.outcome !== 'indeterminate')
        ) {
          const code = PEER_CHAT_PRE_EFFECT_CODES.find(
            (code) => code === rejected.code,
          );
          if (code) return refuseTarget(409, code);
        }
      }
      if (operation.response === 'events' && !response.ok)
        response = await boundedStreamError(response);
      const outputHeaders = new Headers({
        'Content-Type': response.ok
          ? operation.response === 'events'
            ? 'text/event-stream; charset=utf-8'
            : operation.response === 'content'
              ? 'text/plain; charset=utf-8'
              : operation.response === 'media'
                ? 'application/octet-stream'
                : 'application/json; charset=utf-8'
          : 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        [RELAYED_RESPONSE_HEADER]: '1',
      });
      for (const name of [
        'X-Station-Content-Kind',
        'X-Station-Content-Bytes',
        'X-Station-Content-Complete',
        'X-Station-Stream-Epoch',
        'X-Station-Event-Cursor',
      ]) {
        const value = response.headers.get(name);
        if (value !== null) outputHeaders.set(name, value);
      }
      if (
        operation.response === 'events' &&
        response.ok &&
        !response.headers.get('content-type')?.startsWith('text/event-stream')
      ) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Invalid Station event stream');
      }
      if (operation.response === 'media' && response.ok)
        outputHeaders.set(
          'Content-Length',
          response.headers.get('Content-Length')!,
        );
      const output = new Response(response.body, {
        status: response.status,
        headers: outputHeaders,
      });
      return operation.response === 'events'
        ? output
        : guardProjectResponse(output, async () => current());
    } catch {
      if (forwarded) c.header(RELAYED_RESPONSE_HEADER, '1');
      return c.json(
        {
          success: false,
          error:
            operation?.mutation && forwarded
              ? 'The Station did not confirm this change. Check the conversation before sending again.'
              : 'Could not reach the paired Station. Reconnect and try again.',
        },
        502,
      );
    }
  }
  return app;
}

async function boundedStreamError(response: Response): Promise<Response> {
  const reader = response.body?.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  const deadline = setTimeout(() => {
    void reader?.cancel().catch(() => {});
  }, 5000);
  try {
    if (reader)
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 64 * 1024)
          throw new Error('Station error exceeded its byte limit');
        chunks.push(next.value);
      }
  } finally {
    clearTimeout(deadline);
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
  return new Response(Buffer.concat(chunks), {
    status: response.status,
    headers: response.headers,
  });
}
