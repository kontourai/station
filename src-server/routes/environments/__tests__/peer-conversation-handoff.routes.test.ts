import {
  STATION_ENVELOPE_HEADER,
  STATION_ENVELOPE_HEADER_VALUE,
} from '@kontourai/station-contracts/http';
import {
  type ConversationImportRequestV1,
  PEER_CONVERSATION_HANDOFF_ACCESS_CODE,
  PEER_CONVERSATION_HANDOFF_MAX_REQUEST_BYTES,
  PEER_CONVERSATION_HANDOFF_PAIRING_CODE,
  PEER_CONVERSATION_HANDOFF_REFUSAL_CODE,
} from '@kontourai/station-contracts/peer-chat';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createRemoteStationForwarder } from '../../../services/remote-stations/remote-station-forwarder.js';
import { createPeerChatRoutes } from '../peer-chat-routes.js';

const HISTORY: ConversationMessage[] = [
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Plan the move.' }] },
  {
    id: 'a1',
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'private reasoning' } as never,
      { type: 'text', text: 'Step one, then step two.' },
    ],
  },
  // A tool row has no text to carry; it is counted, not sent.
  { id: 't1', role: 'assistant', parts: [{ type: 'tool-call' } as never] },
];

function fixture(
  options: {
    flags?: Record<string, unknown>;
    importReply?: () => Response;
    source?:
      | { agentSlug: string; title: string; messages: ConversationMessage[] }
      | undefined;
    readSourceError?: Error;
    owner?: boolean;
    preview?: boolean;
  } = {},
) {
  const peer = {
    environmentId: 'receiver',
    apiBase: 'https://receiver.test',
    credential: 'test-peer',
    scope: 'orchestration:read orchestration:operate',
    label: 'Receiver',
    createdAt: 1,
    updatedAt: 1,
  };
  const peers = { get: vi.fn(() => ({ ...peer })) };
  const readSource = vi.fn(async () => {
    if (options.readSourceError) throw options.readSourceError;
    return 'source' in options
      ? options.source
      : { agentSlug: 'helper', title: 'Move plan', messages: HISTORY };
  });
  const app = createPeerChatRoutes({
    peers,
    remote: createRemoteStationForwarder({
      peers,
      ssh: { list: () => [], connect: vi.fn() },
    }),
    current: () => true,
    owner: () => options.owner !== false,
    preview: {
      select: (branches) =>
        options.preview === false ? branches.disabled() : branches.enabled(),
    },
    handoff: { readSource },
  });
  const fetch = vi.fn(
    async (input: string | URL | Request, _init?: RequestInit) => {
      if (String(input).endsWith('/.well-known/station/v1'))
        return Response.json({
          environmentId: 'receiver',
          capabilities: options.flags ?? { conversationStationHandoff: true },
        });
      return (
        options.importReply?.() ??
        Response.json(
          {
            success: true,
            data: {
              conversationId: 'conversation:import:abc',
              carriedMessages: 2,
              omittedMessages: 0,
              nonTextMessages: 1,
              idempotent: false,
            },
          },
          {
            headers: {
              [STATION_ENVELOPE_HEADER]: STATION_ENVELOPE_HEADER_VALUE,
            },
          },
        )
      );
    },
  );
  vi.stubGlobal('fetch', fetch);
  const call = (
    body: unknown = {
      idempotencyKey: 'key-1',
      conversationId: 'conversation-one',
      targetAgent: 'helper',
      projectSlug: 'receiver-work',
    },
  ) =>
    app.request('/receiver/conversation-handoffs', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  const imports = () =>
    fetch.mock.calls.filter(([input]) =>
      String(input).endsWith('/conversation-imports'),
    );
  return { call, fetch, imports, readSource };
}

afterEach(() => vi.unstubAllGlobals());

describe('continuing a conversation on a paired Station (source side)', () => {
  test('sends the readable history, text only, to the receiver import with the stored peer credential', async () => {
    const { call, imports, readSource } = fixture();
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        version: 1,
        environmentId: 'receiver',
        conversationId: 'conversation:import:abc',
        carriedMessages: 2,
        omittedMessages: 0,
        nonTextMessages: 1,
        idempotent: false,
      },
    });
    expect(readSource).toHaveBeenCalledWith(
      expect.anything(),
      'conversation-one',
    );
    expect(imports()).toHaveLength(1);
    const [url, init] = imports()[0]!;
    expect(String(url)).toBe(
      'https://receiver.test/agents/helper/conversation-imports',
    );
    expect(new Headers(init!.headers).get('Authorization')).toBe(
      'Bearer test-peer',
    );
    const sent = JSON.parse(String(init!.body)) as ConversationImportRequestV1;
    expect(sent).toEqual({
      version: 1,
      idempotencyKey: 'key-1',
      // Which Station sent it is not claimed: the receiver reads its credential.
      source: {
        conversationId: 'conversation-one',
        title: 'Move plan',
        agent: 'helper',
      },
      projectSlug: 'receiver-work',
      messages: [
        { id: 'u1', role: 'user', text: 'Plan the move.' },
        { id: 'a1', role: 'assistant', text: 'Step one, then step two.' },
      ],
      omittedMessages: 0,
      nonTextMessages: 1,
      shortenedMessages: 0,
    });
  });

  test('refuses a paired Station that does not advertise the import, before sending history', async () => {
    const { call, imports } = fixture({ flags: {} });
    const response = await call();
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error?: string }).error).toBe(
      'Update the paired Station to continue chats there.',
    );
    expect(imports()).toHaveLength(0);
  });

  test('refuses another Agent and an unreadable conversation without contacting the paired Station', async () => {
    const other = fixture();
    expect(
      (
        await other.call({
          idempotencyKey: 'key-1',
          conversationId: 'conversation-one',
          targetAgent: 'someone-else',
        })
      ).status,
    ).toBe(400);
    expect(other.fetch).not.toHaveBeenCalled();
    const unreadable = fixture({ source: undefined });
    expect((await unreadable.call()).status).toBe(404);
    expect(unreadable.fetch).not.toHaveBeenCalled();
  });

  test('refuses a non-owner and a disabled preview before reading anything', async () => {
    const notOwner = fixture({ owner: false });
    expect((await notOwner.call()).status).toBe(403);
    expect(notOwner.readSource).not.toHaveBeenCalled();
    const off = fixture({ preview: false });
    expect((await off.call()).status).toBe(404);
    expect(off.readSource).not.toHaveBeenCalled();
    expect(off.fetch).not.toHaveBeenCalled();
  });

  test("passes the receiver's own refusal on as definite", async () => {
    const { call } = fixture({
      importReply: () =>
        Response.json(
          { success: false, error: 'Target agent not found' },
          {
            status: 404,
            headers: {
              [STATION_ENVELOPE_HEADER]: STATION_ENVELOPE_HEADER_VALUE,
            },
          },
        ),
    });
    const response = await call();
    expect(response.status).toBe(424);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      success: false,
      code: PEER_CONVERSATION_HANDOFF_REFUSAL_CODE,
      error: 'The paired Station refused this chat.',
    });
    // Its own text stays there.
    expect(JSON.stringify(body)).not.toContain('Target agent not found');
    expect(body.outcome).toBeUndefined();
  });

  test.each([
    {
      name: 'a gateway page',
      reply: () => new Response('<html>bad gateway</html>', { status: 502 }),
    },
    {
      name: 'a refusal without the Station envelope',
      reply: () => Response.json({ success: false }, { status: 409 }),
    },
    {
      name: 'a success without a conversation',
      reply: () =>
        Response.json(
          { success: true, data: {} },
          {
            headers: {
              [STATION_ENVELOPE_HEADER]: STATION_ENVELOPE_HEADER_VALUE,
            },
          },
        ),
    },
  ])('reports $name after sending as an unknown outcome', async ({ reply }) => {
    const { call, imports } = fixture({ importReply: reply });
    const response = await call();
    expect(imports()).toHaveLength(1);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      success: false,
      outcome: 'indeterminate',
    });
  });

  test.each([
    {
      name: 'a scope refusal (403 insufficient_scope)',
      status: 403,
      body: { error: { code: 'insufficient_scope' } },
      code: PEER_CONVERSATION_HANDOFF_ACCESS_CODE,
    },
    {
      name: 'an origin refusal (403 origin_forbidden)',
      status: 403,
      body: { error: { code: 'origin_forbidden' } },
      code: PEER_CONVERSATION_HANDOFF_ACCESS_CODE,
    },
    {
      name: 'a body-size refusal (413 request_too_large)',
      status: 413,
      body: { error: { code: 'request_too_large', limit_bytes: 1048576 } },
      code: PEER_CONVERSATION_HANDOFF_REFUSAL_CODE,
    },
  ])(
    "takes the receiver middleware's $name as definite, so a retry is not offered forever",
    async ({ status, body: reply, code }) => {
      const { call } = fixture({
        importReply: () =>
          Response.json(reply, {
            status,
            headers: {
              [STATION_ENVELOPE_HEADER]: STATION_ENVELOPE_HEADER_VALUE,
            },
          }),
      });
      const response = await call();
      expect(response.status).toBe(424);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        success: false,
        code,
      });
      expect(body.outcome).toBeUndefined();
    },
  );

  test('reports the counts the receiver saved, not the ones it read now', async () => {
    const { call } = fixture({
      importReply: () =>
        Response.json(
          {
            success: true,
            data: {
              conversationId: 'conversation:import:abc',
              carriedMessages: 5,
              omittedMessages: 900,
              nonTextMessages: 0,
              idempotent: true,
            },
          },
          {
            headers: {
              [STATION_ENVELOPE_HEADER]: STATION_ENVELOPE_HEADER_VALUE,
            },
          },
        ),
    });
    expect(((await (await call()).json()) as { data: unknown }).data).toEqual({
      version: 1,
      environmentId: 'receiver',
      conversationId: 'conversation:import:abc',
      carriedMessages: 5,
      omittedMessages: 900,
      nonTextMessages: 0,
      idempotent: true,
    });
  });

  test("a failure reading this Station's own chat is said as such, before contacting the paired Station", async () => {
    const portable = Object.assign(
      new Error('This portable task cannot continue.'),
      { code: 'receiver_execution_not_offered' },
    );
    const { call, fetch } = fixture({ readSourceError: portable });
    const response = await call();
    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      success: false,
      error: "This chat can't be continued on another Station.",
      code: 'receiver_execution_not_offered',
    });
    expect(body.outcome).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('bounds the history by its encoded size, so escaped text still fits the receiver body ceiling', async () => {
    // 60 KB of a control character is 360 KB once JSON-escaped.
    const escaped = '\u0001'.repeat(60 * 1024);
    const { call, imports } = fixture({
      source: {
        agentSlug: 'helper',
        title: 'Escapes',
        messages: Array.from({ length: 8 }, (_, index) => ({
          id: `m${index}`,
          role: 'user' as const,
          parts: [{ type: 'text', text: escaped }],
        })),
      },
    });
    expect((await call()).status).toBe(200);
    const sent = String(imports()[0]![1]!.body);
    expect(Buffer.byteLength(sent, 'utf8')).toBeLessThanOrEqual(
      PEER_CONVERSATION_HANDOFF_MAX_REQUEST_BYTES,
    );
    expect(PEER_CONVERSATION_HANDOFF_MAX_REQUEST_BYTES).toBeLessThan(
      1024 * 1024,
    );
    const parsed = JSON.parse(sent) as ConversationImportRequestV1;
    expect(parsed.omittedMessages + parsed.messages.length).toBe(8);
    expect(parsed.shortenedMessages).toBe(parsed.messages.length);
  });

  test.each([
    {
      name: 'a credential the receiver will not let import (403 insufficient_scope)',
      status: 403,
      reply: { error: { code: 'insufficient_scope' } },
      code: PEER_CONVERSATION_HANDOFF_ACCESS_CODE,
    },
    {
      name: "a peer added with a person's device credential (403 paired_station_required)",
      status: 403,
      reply: {
        success: false,
        code: 'paired_station_required',
        error: 'Only a paired Station can continue a conversation here.',
      },
      code: PEER_CONVERSATION_HANDOFF_PAIRING_CODE,
    },
    {
      name: 'an ordinary refusal (404 Target agent not found)',
      status: 404,
      reply: { success: false, error: 'Target agent not found' },
      code: PEER_CONVERSATION_HANDOFF_REFUSAL_CODE,
    },
  ])('names why for $name', async ({ status, reply, code }) => {
    const { call } = fixture({
      importReply: () =>
        Response.json(reply, {
          status,
          headers: { [STATION_ENVELOPE_HEADER]: STATION_ENVELOPE_HEADER_VALUE },
        }),
    });
    const response = await call();
    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({ success: false, code });
  });

  test('a deleted import is named as such, not as a missing Agent', async () => {
    const { call } = fixture({
      importReply: () =>
        Response.json(
          {
            success: false,
            code: 'conversation_import_deleted',
            error: 'deleted',
          },
          {
            status: 409,
            headers: {
              [STATION_ENVELOPE_HEADER]: STATION_ENVELOPE_HEADER_VALUE,
            },
          },
        ),
    });
    const response = await call();
    expect(response.status).toBe(424);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      success: false,
      code: 'conversation_import_deleted',
    });
    expect(body.outcome).toBeUndefined();
  });
});
