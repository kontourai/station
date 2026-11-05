// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import {
  STATION_ENVELOPE_HEADER,
  STATION_ENVELOPE_HEADER_VALUE,
} from '@kontourai/station-contracts/http';
import { PEER_CHAT_REFUSAL_CODE } from '@kontourai/station-contracts/peer-chat';
import type { RuntimeEventContentRef } from '@kontourai/station-contracts/runtime-event-content';
import type { RequestOpenedEvent } from '@kontourai/station-contracts/runtime-events';
import {
  sendExecutionMessageWithInventory,
  setClientCredentialResolver,
} from '@kontourai/station-sdk/client';
import {
  type ApprovalContentBinding,
  computeViewedContentDigest,
} from '@kontourai/station-sdk/runtime-event-content';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { PreviewProvider } from '../../../contexts/PreviewContext';
import type { PendingApprovalRequest } from '../../../hooks/orchestration/pendingRequestRows';
import { describeStationFailure } from '../../../utils/stationFailure';
import { FilePartPreview } from '../../chat/FilePartPreview';
import { InputRequestRequest } from '../../chat/InputRequestRequest';
import { LoadFullContent } from '../../chat/LoadFullContent';
import { MessageDeliveryNote } from '../../chat/message-bubble/MessageDeliveryNote';
import { useApprovalContent } from '../../chat/useApprovalContent';
import { ConversationConnectionProvider } from '../ConversationConnectionContext';
import { createConversationTransport } from '../conversation-transport';
import { useApprovalAnswering } from '../useApprovalAnswering';
import { conversationConnection } from './fixtures';

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://wrong-host.test' }),
  useHostRequestAuthorityScope: () => undefined,
}));

vi.mock('../../../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({ updateChat: vi.fn() }),
}));
vi.mock('../../../contexts/ToastContext', () => ({
  useToast: () => ({ dismissToast: vi.fn() }),
}));

vi.mock('../../../contexts/AuthorityPersistenceContext', () => ({
  useAuthorityPersistence: () => ({
    status: 'verified',
    namespace: 'source-fixture',
  }),
}));

function Controls({
  transport,
}: {
  transport: ReturnType<typeof createConversationTransport>;
}) {
  const answer = useApprovalAnswering('http://wrong-host.test');
  const [state, setState] = useState<'unconfirmed' | 'not-sent'>('unconfirmed');
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void answer(
            'tab',
            'codex',
            'request',
            'Bash',
            'once',
            'child',
            'request-event',
          )
        }
      >
        Allow Once
      </button>
      <MessageDeliveryNote
        state={state}
        port={{
          savedOnDevice: true,
          canDiscardUnconfirmed: false,
          check: async () => {
            const result = await transport.recheckDelivery(
              'conversation',
              'original-key',
            );
            if (result.outcome === 'not-received') setState('not-sent');
            return result.outcome;
          },
          retry: async () => {
            await transport.send(
              {
                target: {
                  environment: { kind: 'current' },
                  agent: agentId('codex'),
                },
                message: 'Retained draft',
                clientTurnId: 'original-key',
              },
              async () => {
                throw new Error('No visual skill');
              },
            );
          },
          edit: async () => null,
          discard: async () => null,
        }}
      />
    </>
  );
}

function ContentApproval({ request }: { request: RequestOpenedEvent }) {
  const answer = useApprovalAnswering('http://wrong-host.test');
  const [answered, setAnswered] = useState(false);
  const { gate, loader } = useApprovalContent(
    {
      type: 'tool-invocation',
      args: request.payload?.toolInput,
      approvalId: request.requestId,
      approvalThreadId: request.threadId,
      approvalEventId: request.eventId,
      approvalContentEvent: request,
    },
    true,
  );
  return (
    <>
      {loader}
      <p>{JSON.stringify(gate.args)}</p>
      <button
        type="button"
        disabled={!gate.allowable || answered}
        onClick={async () => {
          await answer(
            'content-tab',
            'codex',
            request.requestId,
            'Bash',
            'once',
            request.threadId,
            request.eventId,
          );
          setAnswered(true);
        }}
      >
        Allow loaded request
      </button>
      {answered && <p>Decision received</p>}
    </>
  );
}

afterEach(() => {
  cleanup();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test.each(['host', 'direct', 'relay'] as const)(
  '%s approval and uncertain-delivery actions keep their authority and key',
  async (route) => {
    const connection = conversationConnection(route);
    const calls: Array<{ url: string; body?: unknown }> = [];
    setClientCredentialResolver(() => ({
      origin: connection.requestScope.apiBase,
      credential: 'fixture-token',
      requestAuthority: {
        ...connection.requestScope,
        isCurrent: connection.isCurrent,
      },
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        calls.push({
          url: String(input),
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        return Response.json({
          success: true,
          data: String(input).includes('turn-deliveries')
            ? { outcome: 'not-received' }
            : {},
        });
      }),
    );
    const transport = createConversationTransport(connection);
    render(
      <ConversationConnectionProvider
        value={{
          apiBase: connection.targetApiBase,
          station: connection,
          requestScope: {
            ...connection.requestScope,
            isCurrent: connection.isCurrent,
          },
        }}
      >
        <Controls transport={transport} />
      </ConversationConnectionProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Allow Once' }));
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(calls).toEqual([
      {
        url: `${connection.targetApiBase}/api/orchestration/commands`,
        body: expect.objectContaining({
          type: 'respondToRequest',
          threadId: 'child',
          requestId: 'request',
          expectedRequestEventId: 'request-event',
          decision: 'accept',
        }),
      },
      {
        url: `${connection.targetApiBase}/api/orchestration/conversations/conversation/turn-deliveries/original-key`,
      },
      {
        url: `${connection.targetApiBase}/api/orchestration/chat`,
        body: expect.objectContaining({
          clientTurnId: 'original-key',
          message: 'Retained draft',
        }),
      },
    ]);
  },
);

test('a verified relay refusal has Station-aware copy; unverified failure stays uncertain', async () => {
  const connection = conversationConnection('relay');
  setClientCredentialResolver(() => ({
    origin: connection.requestScope.apiBase,
    credential: 'fixture-token',
    requestAuthority: {
      ...connection.requestScope,
      isCurrent: connection.isCurrent,
    },
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          success: false,
          code: PEER_CHAT_REFUSAL_CODE,
          error: 'insufficient_scope',
          details: {
            version: 1,
            failureAuthority: 'target',
            environmentId: connection.environmentId,
            remoteStatus: 403,
            disposition: 'refused-before-dispatch',
            mutationKey: 'original-key',
          },
        },
        {
          status: 424,
          headers: { [STATION_ENVELOPE_HEADER]: STATION_ENVELOPE_HEADER_VALUE },
        },
      ),
    ),
  );
  const error = await sendExecutionMessageWithInventory(
    connection.targetApiBase,
    {
      target: { environment: { kind: 'current' }, agent: agentId('codex') },
      message: 'Keep this draft',
      clientTurnId: 'original-key',
    },
    async () => {
      throw new Error('No visual skill');
    },
    { requestScope: connection.requestScope },
  ).catch((error: unknown) => error);
  expect(
    describeStationFailure(error, connection, 'original-key'),
  ).toMatchObject({
    title: 'Not sent',
    body: 'This connection cannot send to Receiver.',
    delivery: 'refused',
    authority: 'target',
  });
  expect(
    describeStationFailure(error, connection, 'another-key').delivery,
  ).toBe('uncertain');
  expect(
    describeStationFailure(new TypeError('Failed to fetch'), connection)
      .delivery,
  ).toBe('uncertain');
});

test.each(['host', 'direct', 'relay'] as const)(
  '%s loads approval content before answering with that Station’s proof',
  async (route) => {
    vi.stubGlobal('crypto', webcrypto);
    const connection = conversationConnection(route);
    const full = 'echo reviewed on the owning Station';
    const ref: RuntimeEventContentRef = {
      $stationContent: 1,
      ref: `sha256-${'a'.repeat(64)}`,
      kind: 'string',
      bytes: full.length,
      length: full.length,
      preview: 'echo…',
    };
    const request: RequestOpenedEvent = {
      method: 'request.opened',
      eventId: 'content-event',
      requestId: 'content-request',
      provider: 'codex',
      threadId: 'content-child',
      createdAt: '2026-11-04T12:00:00.000Z',
      requestType: 'approval',
      title: 'Allow Bash',
      payload: { toolName: 'Bash', toolInput: { command: ref } },
    };
    const binding: ApprovalContentBinding = {
      requestEventId: request.eventId,
      request,
      bound: [],
      required: true,
      viewedContentDigest: await computeViewedContentDigest(request, []),
    };
    const calls: Array<{ url: string; body?: unknown }> = [];
    setClientCredentialResolver(() => ({
      origin: connection.requestScope.apiBase,
      credential: 'content-fixture-token',
      requestAuthority: {
        ...connection.requestScope,
        isCurrent: connection.isCurrent,
      },
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        calls.push({
          url,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (url.endsWith('/content-binding'))
          return Response.json({ success: true, data: binding });
        if (url.endsWith(`/content/${ref.ref}`))
          return new Response(full, {
            headers: {
              'X-Station-Content-Kind': 'string',
              'X-Station-Content-Bytes': String(full.length),
              'X-Station-Content-Complete': 'true',
            },
          });
        if (url.endsWith('/api/orchestration/commands'))
          return Response.json({ success: true, data: {} });
        throw new Error(`Unexpected approval request: ${url}`);
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    try {
      render(
        <QueryClientProvider client={client}>
          <ConversationConnectionProvider
            value={{
              apiBase: connection.targetApiBase,
              station: connection,
              requestScope: {
                ...connection.requestScope,
                isCurrent: connection.isCurrent,
              },
            }}
          >
            <ContentApproval request={request} />
          </ConversationConnectionProvider>
        </QueryClientProvider>,
      );
      expect(
        screen
          .getByRole('button', { name: 'Allow loaded request' })
          .hasAttribute('disabled'),
      ).toBe(true);
      await screen.findByText(JSON.stringify({ command: full }));
      await userEvent
        .setup()
        .click(screen.getByRole('button', { name: 'Allow loaded request' }));
      await screen.findByText('Decision received');
      expect(calls).toEqual([
        {
          url: `${connection.targetApiBase}/api/orchestration/sessions/content-child/requests/content-request/content-binding`,
        },
        {
          url: `${connection.targetApiBase}/api/orchestration/sessions/content-child/content/${ref.ref}`,
        },
        {
          url: `${connection.targetApiBase}/api/orchestration/commands`,
          body: {
            type: 'respondToRequest',
            threadId: request.threadId,
            requestId: request.requestId,
            expectedRequestEventId: request.eventId,
            decision: 'accept',
            viewedContentDigest: binding.viewedContentDigest,
          },
        },
      ]);
    } finally {
      cleanup();
      client.clear();
    }
  },
);

test.each(['host', 'direct', 'relay'] as const)(
  '%s answers a receiver form through the ordinary input request control',
  async (route) => {
    const connection = conversationConnection(route);
    const request: PendingApprovalRequest = {
      type: 'tool-invocation',
      approvalId: 'branch-request',
      approvalThreadId: 'branch-child',
      approvalEventId: 'branch-event',
      inputRequest: {
        schema: 'station.input-request/v1',
        source: 'mcp:fixture',
        requester: 'Git',
        message: 'Choose a branch',
        body: {
          kind: 'form',
          fields: [
            { name: 'branch', title: 'Branch', kind: 'string', required: true },
          ],
        },
      },
    };
    const calls: Array<{ url: string; body: unknown }> = [];
    setClientCredentialResolver(() => ({
      origin: connection.requestScope.apiBase,
      credential: 'form-fixture-token',
      requestAuthority: {
        ...connection.requestScope,
        isCurrent: connection.isCurrent,
      },
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        calls.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({ success: true, data: {} });
      }),
    );
    render(
      <ConversationConnectionProvider
        value={{
          apiBase: connection.targetApiBase,
          station: connection,
          requestScope: {
            ...connection.requestScope,
            isCurrent: connection.isCurrent,
          },
        }}
      >
        <InputRequestRequest request={request} />
      </ConversationConnectionProvider>,
    );
    const user = userEvent.setup();
    await user.type(
      screen.getByRole('textbox', { name: /Branch/ }),
      'feature/windows',
    );
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(calls).toEqual([
      {
        url: `${connection.targetApiBase}/api/orchestration/commands`,
        body: {
          type: 'respondToRequest',
          threadId: 'branch-child',
          requestId: 'branch-request',
          expectedRequestEventId: 'branch-event',
          decision: 'accept',
          content: { branch: 'feature/windows' },
        },
      },
    ]);
  },
);

test.each(['host', 'direct', 'relay'] as const)(
  '%s loads expanded output and attachment bytes from its target',
  async (route) => {
    const connection = conversationConnection(route);
    const requests: string[] = [];
    const full = 'Full output from the owning Station';
    const spilled: RuntimeEventContentRef = {
      $stationContent: 1,
      ref: 'sha256-' + 'f'.repeat(64),
      kind: 'string',
      bytes: full.length,
      length: full.length,
      preview: 'Output preview',
    };
    setClientCredentialResolver(() => ({
      origin: connection.requestScope.apiBase,
      credential: 'fixture-token',
      requestAuthority: {
        ...connection.requestScope,
        isCurrent: connection.isCurrent,
      },
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        requests.push(String(input));
        expect(new Headers(init?.headers).get('Authorization')).toBe(
          'Bearer fixture-token',
        );
        return new Response(full, {
          headers: {
            'Content-Type': 'text/plain',
            'X-Station-Content-Kind': 'string',
            'X-Station-Content-Bytes': String(full.length),
            'X-Station-Content-Complete': 'true',
          },
        });
      }),
    );
    vi.stubGlobal('URL', URL);
    Object.assign(URL, {
      createObjectURL: () => 'blob:target-file',
      revokeObjectURL: () => {},
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const mounted = render(
      <QueryClientProvider client={client}>
        <PreviewProvider>
          <ConversationConnectionProvider
            value={{
              apiBase: connection.targetApiBase,
              station: connection,
              requestScope: {
                ...connection.requestScope,
                isCurrent: connection.isCurrent,
              },
            }}
          >
            <LoadFullContent<RuntimeEventContentRef | string>
              threadId="child"
              value={spilled}
            >
              {(value) => (
                <p>{typeof value === 'string' ? value : 'Output preview'}</p>
              )}
            </LoadFullContent>
            <FilePartPreview
              part={{
                type: 'file',
                blobRef: 'attachment-ref',
                mediaType: 'text/plain',
                name: 'notes.txt',
              }}
            />
          </ConversationConnectionProvider>
        </PreviewProvider>
      </QueryClientProvider>,
    );
    await screen.findByRole('button', { name: 'Preview notes.txt' });
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Load full content' }));
    await screen.findByText(full);
    expect(requests).toEqual(
      expect.arrayContaining([
        connection.targetApiBase + '/api/attachments/attachment-ref',
        connection.targetApiBase +
          '/api/orchestration/sessions/child/content/' +
          spilled.ref,
      ]),
    );
    expect(requests).toHaveLength(2);
    mounted.unmount();
    client.clear();
  },
);
