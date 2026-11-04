// @vitest-environment jsdom

/**
 * Streaming writes the active-chats store once per token. The dock inbox,
 * Home's work rows and their status facts read only whether a chat is
 * streaming, so their snapshot must hold still across tokens and keystrokes,
 * and still move when a chat starts or stops streaming or changes status.
 */
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeChatsStore } from '../contexts/active-chats-store';
import { openChatStatusSnapshot } from '../contexts/open-chat-status';
import { useOpenChatInbox } from '../contexts/open-chats-store';
import type { AgentSummary } from '../types';
import { buildActiveChatTaskItems } from '../views/home/home-view-model';

const CHAT = 'status-snapshot-chat';
const AGENTS: AgentSummary[] = [
  { slug: agentId('demo-agent'), name: 'Demo agent' },
];

function token(content: string) {
  activeChatsStore.updateChat(CHAT, {
    activityHint: undefined,
    streamingMessage: { role: 'assistant', content },
    planArtifact: undefined,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-10-27T01:00:00.000Z') });
  activeChatsStore.initChat(CHAT, {
    title: 'Status snapshot chat',
    agentSlug: agentId('demo-agent'),
    agentName: 'Demo agent',
  });
});

afterEach(() => {
  cleanup();
  activeChatsStore.removeChat(CHAT);
  vi.useRealTimers();
});

describe('openChatStatusSnapshot', () => {
  it('holds still across streamed tokens and composer keystrokes', () => {
    token('H');
    const streaming = openChatStatusSnapshot();
    expect(streaming[CHAT]?.streamingMessage).toBeTruthy();

    token('He');
    token('Hel');
    activeChatsStore.updateChat(CHAT, { input: 'a follow-up' });
    activeChatsStore.updateChat(CHAT, { isProcessingStep: true });
    expect(openChatStatusSnapshot()).toBe(streaming);
    // The raw map did move each time; only the status reader holds still.
    expect(activeChatsStore.getSnapshot()).not.toBe(streaming);
  });

  it('moves when a chat starts or stops streaming or changes status', () => {
    const idle = openChatStatusSnapshot();
    token('H');
    const streaming = openChatStatusSnapshot();
    expect(streaming).not.toBe(idle);

    activeChatsStore.updateChat(CHAT, { status: 'error' });
    const failed = openChatStatusSnapshot();
    expect(failed).not.toBe(streaming);
    expect(failed[CHAT]?.status).toBe('error');

    activeChatsStore.updateChat(CHAT, { streamingMessage: undefined });
    expect(openChatStatusSnapshot()).not.toBe(failed);
  });

  it('builds the same inbox rows the raw map would', () => {
    token('H');
    openChatStatusSnapshot();
    token('Hello there');
    expect(
      buildActiveChatTaskItems({
        chats: openChatStatusSnapshot(),
        agents: AGENTS,
      }),
    ).toEqual(
      buildActiveChatTaskItems({
        chats: activeChatsStore.getSnapshot(),
        agents: AGENTS,
      }),
    );
  });
});

describe('useOpenChatInbox while a reply streams', () => {
  it('rebuilds the inbox when streaming starts, not on each token', () => {
    const renders: unknown[] = [];
    function Inbox() {
      renders.push(useOpenChatInbox(AGENTS).items);
      return null;
    }
    render(<Inbox />);
    act(() => token('H'));
    const afterStart = renders.length;
    const items = renders.at(-1);

    act(() => {
      for (let index = 1; index <= 40; index += 1) token('H'.repeat(index));
    });
    expect(renders).toHaveLength(afterStart);
    expect(renders.at(-1)).toBe(items);

    act(() => activeChatsStore.updateChat(CHAT, { status: 'queued' }));
    expect(renders.length).toBeGreaterThan(afterStart);
    expect(renders.at(-1)).not.toBe(items);
  });
});
