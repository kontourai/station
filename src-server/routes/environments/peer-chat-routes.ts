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
  CONVERSATION_IMPORT_DELETED_CODE,
  type ConversationImportRequestV1,
  PAIRED_STATION_REQUIRED_CODE,
  PEER_CHAT_PRE_EFFECT_CODES,
  PEER_CHAT_REFUSAL_CODE,
  PEER_CHAT_UPLOAD_GRANT_HEADER,
  PEER_CONVERSATION_HANDOFF_ACCESS_CODE,
  PEER_CONVERSATION_HANDOFF_PAIRING_CODE,
  PEER_CONVERSATION_HANDOFF_REFUSAL_CODE,
  type PeerChatConnectionV1,
  type PeerChatTargetRefusalV1,
  parsePeerConversationHandoffReceipt,
} from '@kontourai/station-contracts/peer-chat';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import { type Context, Hono } from 'hono';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import type { FeaturePreviewSelector } from '../../services/feature-previews/feature-preview-registry.js';
import {
  boundCarriedMessages,
  encodeImportRequest,
  peerConversationHandoffRequestSchema,
} from '../../services/peers/peer-conversation-handoff.js';
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
  /** Continuing a conversation on a paired Station; absent, the route is not served. */
  handoff?: {
    /** The history the caller may read, as `readConversationCarriedHistory` reads it. */
    readSource: (
      c: Context,
      conversationId: string,
    ) => Promise<
      | {
          agentSlug: string;
          title: string;
          messages: readonly ConversationMessage[];
        }
      | undefined
    >;
  };
}) {
  const app = new Hono();
  app.all('/:environmentId/chat-connection', handle);
  app.all('/:environmentId/chat-api/*', handle);
  if (deps.handoff) {
    const handoff = deps.handoff;
    app.post('/:environmentId/conversation-handoffs', (c) =>
      handleConversationHandoff(c, handoff),
    );
  }

  const previewEnabled = () =>
    deps.preview?.select({ enabled: () => true, disabled: () => false }) ===
    true;

  /**
   * #machine-handoff: the source half of continuing a conversation on a
   * paired Station. This Station reads the history the caller may read,
   * bounds it, and sends it with its own stored peer credential, the same one
   * the relay uses, so the receiver records the import for the principal the
   * relayed first turn will run as. It starts no turn: the caller sends that
   * through the relay to the conversation this returns. Same-key retries are
   * answered by the receiver, which owns the effect.
   */
  async function handleConversationHandoff(
    c: Context,
    handoff: NonNullable<typeof deps.handoff>,
  ) {
    const request = c.req.raw;
    const previewGeneration = deps.previewGeneration?.();
    if (
      requestMayBeAnAgent(request) ||
      !deps.current(request) ||
      !deps.owner(request)
    )
      return c.json({ success: false, error: 'Forbidden' }, 403);
    if (!previewEnabled()) return previewDisabled(c);
    const bounded = await readBoundedRequestBody(request, 16 * 1024);
    let parsedBody: unknown;
    try {
      parsedBody =
        bounded.status === 'ok' ? JSON.parse(bounded.body) : undefined;
    } catch {
      parsedBody = undefined;
    }
    const parsed = peerConversationHandoffRequestSchema.safeParse(parsedBody);
    if (!parsed.success)
      return c.json({ success: false, error: 'Invalid handoff request' }, 400);
    const body = parsed.data;
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
    // Reading this Station's own chat fails here, definitely and before any
    // contact with the paired Station: never as "could not reach" it.
    let source: Awaited<ReturnType<typeof handoff.readSource>>;
    try {
      source = await handoff.readSource(c, body.conversationId);
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
      return c.json(
        {
          success: false,
          error: "This chat can't be continued on another Station.",
          ...(typeof code === 'string' ? { code } : {}),
        },
        409,
      );
    }
    let forwarded = false;
    try {
      if (!source)
        return c.json({ success: false, error: 'Conversation not found' }, 404);
      if (source.agentSlug !== body.targetAgent)
        return c.json(
          {
            success: false,
            error:
              'A conversation continues on another Station with the same Agent.',
          },
          400,
        );
      const carried = boundCarriedMessages(source.messages);
      if (carried.messages.length === 0)
        return c.json(
          {
            success: false,
            error: 'This chat has no messages to carry yet.',
          },
          409,
        );
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
      const handshake = await fetchRemoteStationBytes(
        `${target.apiBase}/.well-known/station/v1`,
        { headers: target.requestOptions.headers, signal: request.signal },
        target.requestOptions.timeoutMs,
        current,
        64 * 1024,
      );
      const identity: unknown = await handshake.json().catch(() => null);
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
          ? (identity.capabilities as Record<string, unknown>)
          : {};
      if (flags.conversationStationHandoff !== true)
        return c.json(
          {
            success: false,
            error: 'Update the paired Station to continue chats there.',
          },
          409,
        );
      const encoded = encodeImportRequest({
        version: 1,
        idempotencyKey: body.idempotencyKey,
        source: {
          conversationId: body.conversationId,
          title: source.title.slice(0, 500),
          agent: source.agentSlug,
        },
        ...(body.projectSlug ? { projectSlug: body.projectSlug } : {}),
        ...carried,
      } satisfies ConversationImportRequestV1);
      if (encoded === null)
        return c.json(
          {
            success: false,
            error:
              "This chat's history is too large to send to another Station.",
          },
          413,
        );
      const headers = new Headers(target.requestOptions.headers);
      headers.set(
        CLIENT_PROTOCOL_HEADER,
        String(STATION_COMPAT_PROTOCOL_VERSION),
      );
      headers.set('Content-Type', 'application/json');
      if (!current())
        return c.json(
          { success: false, error: 'Station access changed.' },
          409,
        );
      forwarded = true;
      const response = await fetchRemoteStationBytes(
        `${target.apiBase}/agents/${encodeURIComponent(body.targetAgent)}/conversation-imports`,
        {
          method: 'POST',
          headers,
          body: encoded,
          signal: request.signal,
        },
        target.requestOptions.timeoutMs,
        current,
        256 * 1024,
      );
      const reply: unknown = await response.json().catch(() => null);
      const replyRecord =
        reply && typeof reply === 'object'
          ? (reply as Record<string, unknown>)
          : {};
      const data =
        replyRecord.data && typeof replyRecord.data === 'object'
          ? (replyRecord.data as Record<string, unknown>)
          : {};
      // The receipt is the receiver's account of what it SAVED, so a
      // same-key retry reports the first request's counts.
      const receipt = response.ok
        ? parsePeerConversationHandoffReceipt(
            { ...data, version: 1, environmentId: id },
            { environmentId: id },
          )
        : null;
      if (receipt && replyRecord.success === true)
        return c.json({ success: true, data: receipt });
      // Any 4xx carrying the Station envelope is that Station's own refusal,
      // whether a route's `{success:false}` or a middleware's `{error:{code}}`
      // (scope, origin, body size): nothing was saved, so it is definite.
      // Anything else after the request left (a gateway page, a 5xx, an
      // unreadable success) leaves the outcome unknown; the key is retried.
      const definite =
        response.status >= 400 &&
        response.status < 500 &&
        response.headers.get(STATION_ENVELOPE_HEADER) ===
          STATION_ENVELOPE_HEADER_VALUE;
      if (!definite) throw new Error('Unconfirmed conversation import');
      // The paired Station's own text is not relayed: it may name its
      // internals, and its copy is not this Station's to show. Its machine
      // code says which of three reasons applies.
      const pairingRequired =
        response.status === 403 &&
        replyRecord.code === PAIRED_STATION_REQUIRED_CODE;
      const access = response.status === 401 || response.status === 403;
      // An import deleted there before it started is its own, definite case:
      // nothing remains, so a new request sends a fresh copy.
      const deleted =
        !access && replyRecord.code === CONVERSATION_IMPORT_DELETED_CODE;
      return c.json(
        {
          success: false,
          code: pairingRequired
            ? PEER_CONVERSATION_HANDOFF_PAIRING_CODE
            : access
              ? PEER_CONVERSATION_HANDOFF_ACCESS_CODE
              : deleted
                ? CONVERSATION_IMPORT_DELETED_CODE
                : PEER_CONVERSATION_HANDOFF_REFUSAL_CODE,
          error: pairingRequired
            ? 'The paired Station takes chats only from a Station paired with it as a Station.'
            : access
              ? "The paired Station didn't let this Station continue chats there."
              : deleted
                ? 'That chat was removed on the paired Station. Try again to send a fresh copy.'
                : 'The paired Station refused this chat.',
        },
        424,
      );
    } catch {
      return c.json(
        {
          success: false,
          error: forwarded
            ? "The paired Station didn't confirm the handoff. Retrying won't create a second chat."
            : 'Could not reach the paired Station. Reconnect and try again.',
          ...(forwarded ? { outcome: 'indeterminate' } : {}),
        },
        502,
      );
    }
  }

  function previewDisabled(c: Context) {
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
  }

  async function handle(c: Context) {
    const request = c.req.raw;
    const previewGeneration = deps.previewGeneration?.();
    if (
      requestMayBeAnAgent(request) ||
      !deps.current(request) ||
      !deps.owner(request)
    )
      return c.json({ success: false, error: 'Forbidden' }, 403);
    if (!previewEnabled()) return previewDisabled(c);
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
