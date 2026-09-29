/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ComposerAttachmentStrip } from '../components/chat/ComposerAttachmentStrip';
import { ActiveChatsStore } from '../contexts/active-chats-store';
import { useComposerAttachments } from '../hooks/useComposerAttachments';

vi.mock('@kontourai/station-sdk/client', () => ({
  cancelAttachmentStage: vi.fn(),
  reconcileAttachmentStages: vi.fn(async () => []),
  xhrAttachmentStageUpload: vi.fn(),
}));

class MemoryStorage {
  private values = new Map<string, string>();
  constructor(seed: Record<string, string>) {
    for (const [key, value] of Object.entries(seed))
      this.values.set(key, value);
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

/** The composer's attachment consumers, fed exactly what a restore produced. */
function RestoredComposer({
  store,
  id,
}: {
  store: ActiveChatsStore;
  id: string;
}) {
  const chat = store.getSnapshot()[id]!;
  const composer = useComposerAttachments({
    apiBase: 'http://station.test',
    ownerKey: id,
    attachments: chat.attachments ?? [],
    stages: chat.attachmentStages ?? [],
    capabilities: { images: true, files: true },
    onAddAttachments: vi.fn(),
    onStagesChange: vi.fn(),
  });
  return (
    <div>
      <ComposerAttachmentStrip
        attachments={chat.attachments ?? []}
        stages={chat.attachmentStages}
        onRemove={vi.fn()}
      />
      <p data-testid="gate">{composer.sendBlockedReason ?? 'sendable'}</p>
      <p data-testid="history">{(chat.inputHistory ?? []).join('|')}</p>
      <p data-testid="title">{chat.title ?? 'untitled'}</p>
    </div>
  );
}

describe('restoring persisted chats from an older or corrupt payload', () => {
  // The phone's "Chat could not open": a UI build reloaded into a payload
  // whose nested `attachmentStages` was not the shape it reads, and render
  // threw `stages.some is not a function` on every retry.
  test('malformed nested fields are dropped or repaired, and the composer still renders', () => {
    const payload = [
      {
        sessionId: 'chat-1',
        agentSlug: 'grok-build',
        conversationId: 'conv-1',
        title: { text: 'an old object-shaped title' },
        attachmentStages: {
          'shot.png': { state: 'complete' },
        },
        inputHistory: ['first', 42, null, 'second'],
        queuedMessages: 'not a list',
        unsentMessages: [
          { id: 'u1', content: 'keep me', reason: 'offline', at: 1 },
          { id: 'u2', content: 7 },
        ],
        queuedMessageFailure: 'boom',
        providerOptions: ['bad'],
        planArtifact: { steps: 'nope' },
        flowRun: { runId: 1 },
        sessionAutoApprove: [1, 'bash'],
      },
      {
        sessionId: 'chat-2',
        agentSlug: 'opencode',
        attachmentStages: [
          { clientAttachmentId: 'a', name: 'a.png' },
          {
            clientAttachmentId: 'b',
            name: 'b.png',
            mimeType: 'image/png',
            size: 3,
            state: 'complete',
            progress: 1,
          },
          {
            clientAttachmentId: 'c',
            name: 'c.png',
            mimeType: 'image/png',
            size: 3,
            state: 'teleporting',
            progress: 1,
          },
        ],
      },
      { agentSlug: 'no-session-id' },
      'not even an object',
    ];
    const store = new ActiveChatsStore({
      storage: new MemoryStorage({ activeChats: JSON.stringify(payload) }),
    });
    const chats = store.getSnapshot();

    expect(Object.keys(chats).sort()).toEqual(['chat-1', 'chat-2']);
    const one = chats['chat-1']!;
    expect(one.attachmentStages).toEqual([]);
    expect(one.inputHistory).toEqual(['first', 'second']);
    expect(one.queuedMessages).toEqual([]);
    expect(one.unsentMessages).toEqual([
      { id: 'u1', content: 'keep me', reason: 'offline', at: 1 },
    ]);
    expect(one.queuedMessageFailure).toBeUndefined();
    expect(one.title).toBeUndefined();
    expect(one.providerOptions).toEqual({});
    expect(one.planArtifact).toBeNull();
    expect(one.flowRun).toBeNull();
    expect(one.sessionAutoApprove).toEqual(['bash']);
    // A "complete" stage whose send reference did not survive is not
    // sendable; it asks for its file instead of claiming Ready. Unknown
    // states and partial stages are dropped.
    expect(chats['chat-2']!.attachmentStages).toEqual([
      expect.objectContaining({
        clientAttachmentId: 'b',
        state: 'failed',
        needsFile: true,
      }),
    ]);

    render(<RestoredComposer store={store} id="chat-1" />);
    expect(screen.getByTestId('gate').textContent).toBe('sendable');
    expect(screen.getByTestId('history').textContent).toBe('first|second');
    expect(screen.getByTestId('title').textContent).toBe('untitled');

    render(<RestoredComposer store={store} id="chat-2" />);
    expect(screen.getByText('Choose the file again')).toBeTruthy();
  });

  test('a payload that is not a list restores nothing instead of throwing', () => {
    const store = new ActiveChatsStore({
      storage: new MemoryStorage({
        activeChats: JSON.stringify({ sessionId: 'x' }),
      }),
    });
    expect(store.getSnapshot()).toEqual({});
  });
});
