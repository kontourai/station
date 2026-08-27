import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://example.test'),
}));

import { COOPERATIVE_STOP_BUDGET_MS } from '@kontourai/station-contracts/orchestration';
import {
  cleanupTerminalProcess,
  dispatchOrchestrationCommand,
  dispatchOrchestrationCommandWithReceipt,
  fetchLoadedOrchestrationSessions,
  fetchOrchestrationCommandReceipt,
  fetchOrchestrationCommandReceipts,
  fetchOrchestrationSession,
  fetchOrchestrationSessions,
  fetchTerminalProcess,
  fetchTerminalProcesses,
  interruptOrchestrationDelegatedTask,
  interruptOrchestrationTurn,
  STOP_REQUEST_BUDGET_MS,
  sendOrchestrationTurn,
} from '../query-domains/chatRuntimeOrchestration';

function mockJsonResponse(payload: unknown, ok = true) {
  vi.mocked(fetch).mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => payload,
  } as Response);
}

describe('chatRuntimeOrchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('fetches orchestration sessions through the read-model route', async () => {
    mockJsonResponse({ success: true, data: [{ threadId: 'thread-1' }] });

    // station#1778: these fixtures model a server that sent NO
    // `answerability` — a peer older than ADR 0012 — and the client
    // normalizes it at the wire boundary rather than handing consumers a
    // required member that is `undefined` at runtime.
    await expect(fetchOrchestrationSessions()).resolves.toEqual([
      { threadId: 'thread-1', answerability: { answerable: true } },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/orchestration/sessions/read-model',
    );
  });

  it('fetches loaded orchestration sessions through the loaded route', async () => {
    mockJsonResponse({ success: true, data: [{ threadId: 'thread-2' }] });

    await expect(fetchLoadedOrchestrationSessions()).resolves.toEqual([
      { threadId: 'thread-2', answerability: { answerable: true } },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/orchestration/sessions/loaded',
    );
  });

  it('fetches one orchestration session detail', async () => {
    mockJsonResponse({
      success: true,
      data: { session: { threadId: 'thread-3' }, events: [] },
    });

    await expect(fetchOrchestrationSession('thread-3')).resolves.toEqual({
      session: { threadId: 'thread-3', answerability: { answerable: true } },
      events: [],
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/orchestration/sessions/thread-3',
    );
  });

  it('dispatches commands with receipt metadata while preserving result-only compatibility', async () => {
    const payload = {
      success: true,
      data: { threadId: 'thread-4', turnId: 'turn-1' },
      receipt: {
        commandId: 'cmd-4',
        threadId: 'thread-4',
        commandType: 'adoptSession',
        status: 'accepted',
        createdAt: '2026-03-28T00:00:00.000Z',
      },
      receiptStatus: 'unavailable' as const,
    };
    mockJsonResponse(payload);

    await expect(
      dispatchOrchestrationCommand({
        type: 'adoptSession',
        sourceThreadId: 'thread-4',
      }),
    ).resolves.toEqual({ threadId: 'thread-4', turnId: 'turn-1' });

    mockJsonResponse(payload);
    await expect(
      dispatchOrchestrationCommandWithReceipt(
        {
          type: 'adoptSession',
          sourceThreadId: 'thread-4',
        },
        undefined,
        1234,
      ),
    ).resolves.toEqual({
      result: { threadId: 'thread-4', turnId: 'turn-1' },
      receipt: payload.receipt,
      receiptStatus: 'unavailable',
    });
    expect(fetch).toHaveBeenLastCalledWith(
      'http://example.test/api/orchestration/commands',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('sends ambient context out-of-band on sendTurn and omits it when absent (#685)', async () => {
    mockJsonResponse({
      success: true,
      data: {
        conversationId: 'thread-6',
        sessionId: 'thread-6',
        providerTurnId: 'provider-turn-ambient',
      },
    });

    await expect(
      sendOrchestrationTurn({
        threadId: 'thread-6',
        text: 'what time is it?',
        ambientContext: '[Timezone: America/Denver]',
      }),
    ).resolves.toMatchObject({ providerTurnId: 'provider-turn-ambient' });
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/orchestration/chat/thread-6/continue',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          message: 'what time is it?',
          ambientContext: '[Timezone: America/Denver]',
        }),
      }),
    );

    mockJsonResponse({
      success: true,
      data: {
        conversationId: 'thread-6',
        sessionId: 'thread-6',
        providerTurnId: 'provider-turn-plain',
      },
    });
    await expect(
      sendOrchestrationTurn({ threadId: 'thread-6', text: 'hello' }),
    ).resolves.toMatchObject({ providerTurnId: 'provider-turn-plain' });
    expect(fetch).toHaveBeenLastCalledWith(
      'http://example.test/api/orchestration/chat/thread-6/continue',
      expect.objectContaining({
        body: JSON.stringify({ message: 'hello' }),
      }),
    );
  });

  it('serializes bounded attachment metadata on orchestration turns', async () => {
    mockJsonResponse({
      success: true,
      data: {
        conversationId: 'thread-attachment',
        sessionId: 'thread-attachment',
        providerTurnId: 'provider-turn-attachment',
      },
    });

    await expect(
      sendOrchestrationTurn({
        threadId: 'thread-attachment',
        text: 'Review this',
        attachments: [
          {
            kind: 'image',
            name: 'screen.png',
            mimeType: 'image/png',
            size: 3,
            dataUrl: 'data:image/png;base64,YWJj',
          },
        ],
      }),
    ).resolves.toMatchObject({ providerTurnId: 'provider-turn-attachment' });

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/orchestration/chat/thread-attachment/continue',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          message: 'Review this',
          attachments: [
            {
              kind: 'image',
              name: 'screen.png',
              mimeType: 'image/png',
              size: 3,
              dataUrl: 'data:image/png;base64,YWJj',
            },
          ],
        }),
      }),
    );
  });

  it('interrupts a running task without stopping its resumable session', async () => {
    mockJsonResponse({ success: true, data: null });

    await expect(
      interruptOrchestrationTurn({
        threadId: 'task:child',
        turnId: 'turn-7',
      }),
    ).resolves.toBeNull();

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/orchestration/commands',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          type: 'interruptTurn',
          threadId: 'task:child',
          turnId: 'turn-7',
        }),
      }),
    );
  });

  // UX audit T1: Stop had no client-side deadline at all, so a transport that
  // never answered left the composer's pending state stranded forever. The
  // budget must also OUTWAIT the server's own cancel-acknowledgement budget —
  // the forced path only begins once that expires — or a working stop would be
  // aborted and reported as a failure that never happened.
  it('gives the interrupt a client deadline that outwaits the server cancel budget', async () => {
    expect(STOP_REQUEST_BUDGET_MS).toBeGreaterThan(COOPERATIVE_STOP_BUDGET_MS);

    vi.mocked(fetch).mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          signal?.addEventListener('abort', () =>
            reject(new Error('aborted by deadline')),
          );
        }),
    );

    await expect(
      interruptOrchestrationTurn({ threadId: 'thread-hang', timeoutMs: 5 }),
    ).rejects.toThrow();
  });

  it('interrupts a delegated task through its task-scoped control route', async () => {
    mockJsonResponse({
      success: true,
      data: { taskId: 'task:child', interruptRequested: true },
    });

    await expect(
      interruptOrchestrationDelegatedTask({ taskId: 'task:child' }),
    ).resolves.toMatchObject({
      taskId: 'task:child',
      interruptRequested: true,
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/orchestration/delegations/task%3Achild/interrupt',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });

  it('fetches orchestration command receipts by thread and command id', async () => {
    const receipt = {
      commandId: 'cmd-5',
      threadId: 'thread-5',
      commandType: 'interruptTurn',
      status: 'accepted',
      createdAt: '2026-03-28T00:00:00.000Z',
    };
    mockJsonResponse({ success: true, data: [receipt] });

    await expect(
      fetchOrchestrationCommandReceipts({ threadId: 'thread-5' }),
    ).resolves.toEqual([receipt]);
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/orchestration/commands/receipts?threadId=thread-5',
    );

    mockJsonResponse({ success: true, data: receipt });
    await expect(fetchOrchestrationCommandReceipt('cmd-5')).resolves.toEqual(
      receipt,
    );
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/orchestration/commands/receipts/cmd-5',
    );
  });

  it('fetches terminal process summaries and detail', async () => {
    mockJsonResponse({ success: true, data: [{ sessionId: 'demo:t1' }] });
    await expect(fetchTerminalProcesses()).resolves.toEqual([
      { sessionId: 'demo:t1' },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/orchestration/processes/terminals',
    );

    mockJsonResponse({
      success: true,
      data: { process: { sessionId: 'demo:t1' }, history: '' },
    });
    await expect(fetchTerminalProcess('demo:t1')).resolves.toEqual({
      process: { sessionId: 'demo:t1' },
      history: '',
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/orchestration/processes/terminals/demo%3At1',
    );
  });

  it('cleans up a terminal process through the delete route', async () => {
    mockJsonResponse({ success: true });

    await expect(
      cleanupTerminalProcess({ sessionId: 'demo:t1' }),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith(
      'http://example.test/api/orchestration/processes/terminals/demo%3At1',
      { method: 'DELETE' },
    );
  });
});
