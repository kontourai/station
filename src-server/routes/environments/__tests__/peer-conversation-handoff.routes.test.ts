import {
  STATION_ENVELOPE_HEADER,
  STATION_ENVELOPE_HEADER_VALUE,
} from '@kontourai/station-contracts/http';
import {
  type ConversationImportRequestV1,
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
  const readSource = vi.fn(async () =>
    'source' in options
      ? options.source
      : { agentSlug: 'helper', title: 'Move plan', messages: HISTORY },
  );
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
    handoff: {
      readSource,
      sourceStation: async () => ({ environmentId: 'source', name: 'Laptop' }),
    },
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
        shortenedMessages: 0,
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
      source: {
        environmentId: 'source',
        stationName: 'Laptop',
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
    expect((await response.json()).error).toBe(
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
    const body = await response.json();
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
});
