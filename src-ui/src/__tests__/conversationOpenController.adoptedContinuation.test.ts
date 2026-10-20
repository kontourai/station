/** @vitest-environment jsdom */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { openConversationForDock } from '../components/chat-dock/conversationOpenController';

/**
 * #3429: `ImportedConversationPane`'s `onContinueInDock` is the dock's
 * `openConversationForDock` with the continuation's id. This drives that
 * controller through the real SDK open read, against the open resolution the
 * server returns for a continuation bound to its engine's Agent (pinned by
 * `adopted-continuation-dock.routes.test.ts`), and against the 404 an unbound
 * continuation gets.
 */
const CHILD = '0f9c1e2a-7b7d-4a8e-9a43-3b9d6f1d2c11';

function adoptedChildResolution() {
  return {
    status: 'resolved',
    conversation: {
      id: CHILD,
      source: 'runtime',
      agentSlug: 'claude',
      title: 'Continued conversation',
      createdAt: '2026-10-05T00:00:00.000Z',
      updatedAt: '2026-10-05T00:00:01.000Z',
      messageCount: 0,
      mutable: false,
      answerability: { answerable: true },
      environmentId: 'environment-local',
    },
    currentSessionId: CHILD,
    execution: {
      sessionId: CHILD,
      agentId: 'claude',
      provider: 'claude',
      engineConnectionId: 'claude',
    },
    transcript: { available: true, owner: 'runtime', messageCount: 0 },
    canContinue: true,
    answerability: { answerable: true },
    recoveryActions: [],
  };
}

function respond(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function effects() {
  const tabs = new Map<string, string>();
  const open = vi.fn(async (conversationId: string, agentSlug: string) => {
    tabs.set(conversationId, `tab-for-${agentSlug}`);
    return true;
  });
  return {
    apiBase: 'http://station.test',
    open,
    projectName: () => undefined,
    findTab: (conversationId: string) => tabs.get(conversationId),
    updateChat: vi.fn(),
    setRecovery: vi.fn(),
    isCurrent: () => true,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('#3429: Continue in Station opens the continuation in the dock', () => {
  test('a continuation bound to its engine Agent opens a tab for that Agent', async () => {
    const fetchMock = respond(200, {
      success: true,
      data: adoptedChildResolution(),
    });
    const dock = effects();

    await expect(openConversationForDock(CHILD, dock)).resolves.toBe(true);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://station.test/api/conversations/${CHILD}/open`,
    );
    expect(dock.open).toHaveBeenCalledOnce();
    expect(dock.open.mock.calls[0]?.slice(0, 2)).toEqual([CHILD, 'claude']);
    expect(dock.updateChat).toHaveBeenCalledWith(
      'tab-for-claude',
      expect.objectContaining({
        agentSlug: 'claude',
        orchestrationProvider: 'claude',
        agentConnectionId: 'claude',
        currentSessionId: CHILD,
        orchestrationSessionStarted: true,
      }),
    );
    expect(dock.setRecovery).toHaveBeenCalledWith(null);
  });

  test('an unbound continuation (the open read 404s) opens no tab', async () => {
    respond(404, { success: false, error: 'Conversation not found' });
    const dock = effects();

    await expect(openConversationForDock(CHILD, dock)).resolves.toBe(false);

    expect(dock.open).not.toHaveBeenCalled();
    expect(dock.updateChat).not.toHaveBeenCalled();
  });
});
