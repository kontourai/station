/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mutate = vi.fn();
vi.mock('@kontourai/station-sdk', () => ({
  useAcknowledgeConversationMutation: () => ({ mutate }),
}));

const {
  useAcknowledgeVisibleConversation,
  visibleConversationAcknowledgement,
} = await import('../components/chat-dock/useAcknowledgeVisibleConversation');

type Item = Parameters<typeof visibleConversationAcknowledgement>[0];

const running: NonNullable<Item> = {
  id: 'c1',
  lifecycleLabel: 'Running',
  conversationUpdatedAt: '2026-10-28T10:00:00.000Z',
};
const finished: NonNullable<Item> = {
  ...running,
  lifecycleLabel: 'Completed',
  conversationUpdatedAt: '2026-10-28T10:05:00.000Z',
};

let focused = true;
beforeEach(() => {
  focused = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
});

describe('useAcknowledgeVisibleConversation (#4266)', () => {
  beforeEach(() => mutate.mockClear());

  it('watching a thread finish records the finished version, once', () => {
    const { rerender } = renderHook(
      ({ item }) => useAcknowledgeVisibleConversation(item, true),
      { initialProps: { item: running } },
    );
    // Opening it while it works records one view.
    expect(mutate).toHaveBeenCalledExactlyOnceWith({
      conversationId: 'c1',
      updatedAt: '2026-10-28T10:00:00.000Z',
    });
    // Later inventory refreshes while it works record nothing more.
    rerender({
      item: { ...running, conversationUpdatedAt: '2026-10-28T10:02:00.000Z' },
    });
    expect(mutate).toHaveBeenCalledTimes(1);
    rerender({ item: finished });
    expect(mutate).toHaveBeenLastCalledWith({
      conversationId: 'c1',
      updatedAt: '2026-10-28T10:05:00.000Z',
    });
    rerender({ item: { ...finished } });
    expect(mutate).toHaveBeenCalledTimes(2);
  });

  it('records nothing while the pane is hidden or the version is already viewed', () => {
    const { rerender } = renderHook(
      ({ item, visible }) => useAcknowledgeVisibleConversation(item, visible),
      { initialProps: { item: finished, visible: false } },
    );
    expect(mutate).not.toHaveBeenCalled();
    rerender({
      item: {
        ...finished,
        acknowledgedAt: Date.parse(finished.conversationUpdatedAt!),
      },
      visible: true,
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it('a thread that finishes while the pane is hidden is recorded when it is shown again', () => {
    const { rerender } = renderHook(
      ({ item, visible }) => useAcknowledgeVisibleConversation(item, visible),
      { initialProps: { item: running, visible: true } },
    );
    rerender({ item: running, visible: false });
    rerender({ item: finished, visible: false });
    expect(mutate).toHaveBeenCalledTimes(1);
    rerender({ item: finished, visible: true });
    expect(mutate).toHaveBeenLastCalledWith({
      conversationId: 'c1',
      updatedAt: '2026-10-28T10:05:00.000Z',
    });
  });
});

describe('useAcknowledgeVisibleConversation with server read state (#3075)', () => {
  beforeEach(() => mutate.mockClear());

  it('records every version the server calls unread while on screen, so another device agrees mid-turn', () => {
    const { rerender } = renderHook(
      ({ item }) => useAcknowledgeVisibleConversation(item, true),
      { initialProps: { item: { ...running, unread: true } } },
    );
    expect(mutate).toHaveBeenCalledTimes(1);
    // New output while it works: no live-turn throttle when the server says.
    rerender({
      item: {
        ...running,
        conversationUpdatedAt: '2026-10-28T10:02:00.000Z',
        unread: true,
      },
    });
    expect(mutate).toHaveBeenLastCalledWith({
      conversationId: 'c1',
      updatedAt: '2026-10-28T10:02:00.000Z',
    });
    // Read on the server and this version already on record: nothing to
    // send. ("Read" alone may be the baseline; see the next describe.)
    rerender({
      item: {
        ...finished,
        unread: false,
        acknowledgedAt: Date.parse(finished.conversationUpdatedAt!),
      },
    });
    expect(mutate).toHaveBeenCalledTimes(2);
  });

  it('a chat on screen in a window that is not focused stays unread, and is recorded once focus returns', () => {
    focused = false;
    renderHook(() =>
      useAcknowledgeVisibleConversation({ ...finished, unread: true }, true),
    );
    expect(mutate).not.toHaveBeenCalled();
    focused = true;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(mutate).toHaveBeenCalledExactlyOnceWith({
      conversationId: 'c1',
      updatedAt: '2026-10-28T10:05:00.000Z',
    });
  });
});

describe('the last-viewed record stays independent of the baseline (#3075 review)', () => {
  beforeEach(() => mutate.mockClear());

  it('a finished thread the server reads as seen (baseline) but whose last view predates its finish is still recorded when shown', () => {
    renderHook(() =>
      useAcknowledgeVisibleConversation(
        {
          ...finished,
          unread: false,
          acknowledgedAt: Date.parse('2026-10-28T10:01:00.000Z'),
        },
        true,
      ),
    );
    // Without this record Home's "Just finished" (acknowledgedAt < finish)
    // would keep the thread there however often it is viewed.
    expect(mutate).toHaveBeenCalledExactlyOnceWith({
      conversationId: 'c1',
      updatedAt: '2026-10-28T10:05:00.000Z',
    });
  });

  it('a version already on record is still not sent again', () => {
    renderHook(() =>
      useAcknowledgeVisibleConversation(
        {
          ...finished,
          unread: false,
          acknowledgedAt: Date.parse('2026-10-28T10:05:00.000Z'),
        },
        true,
      ),
    );
    expect(mutate).not.toHaveBeenCalled();
  });
});
