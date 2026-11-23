// @vitest-environment jsdom
/**
 * The inbox's Mark done actions at the seam every host calls: what each one
 * records, what its notice says, and that the one latest notice is the only
 * Undo on offer.
 */
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatDraftsStore } from '../../../contexts/chat-drafts-store';
import { toastStore } from '../../../contexts/ToastContext';
import type { HomeWorkItem } from '../../../views/home/home-view-model';
import {
  resetPendingUndoForTest,
  undoLatestAction,
} from '../../undo/UndoableActionShortcut';
import {
  InboxDismissUndo,
  offerInboxUndo,
  useInboxDismissActions,
} from '../inbox-dismissals';

const station = vi.hoisted(() => ({ apiBase: 'http://localhost' }));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: station.apiBase }),
}));

const work = vi.hoisted(() => ({
  supported: true,
  hideSupported: true,
  hidden: {} as Record<string, string>,
  change: { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false },
  hide: { mutate: vi.fn(), mutateAsync: vi.fn() },
}));
vi.mock('../useConversationWorkState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../useConversationWorkState')>()),
  useConversationWorkState: () => ({
    ...work,
    settled: {},
    query: { isError: false, refetch: () => undefined },
    migrateHidden: async () => [],
    scopeKey: 'k',
  }),
}));

const owned: HomeWorkItem = {
  id: 'owned',
  conversationId: 'owned',
  kind: 'orchestration',
  kindLabel: 'Conversation',
  title: 'Owned chat',
  projectLabel: 'Station',
  agentLabel: 'Agent A',
  modelLabel: 'Model A',
  lifecycleLabel: 'Running',
  updatedAt: 1000,
};
const external: HomeWorkItem = {
  ...owned,
  id: 'external-thread',
  conversationId: undefined,
  controlMode: 'read-only-attached',
};

let actions!: ReturnType<typeof useInboxDismissActions>;
function Probe({ items }: { items: HomeWorkItem[] }) {
  actions = useInboxDismissActions(items);
  return null;
}
const mount = (items: HomeWorkItem[]) =>
  render(
    <InboxDismissUndo>
      <Probe items={items} />
    </InboxDismissUndo>,
  );
const notices = () =>
  toastStore
    .getSnapshot()
    .filter((toast) => toast.actions?.some((a) => a.label === 'Undo'));

beforeEach(() => {
  toastStore.clear();
  localStorage.clear();
  resetPendingUndoForTest();
  station.apiBase = 'http://localhost';
  work.supported = true;
  work.hideSupported = true;
  work.hidden = {};
  work.change.mutate.mockReset();
  work.change.mutateAsync.mockReset();
  work.hide.mutate.mockReset();
});

describe('Mark done notices', () => {
  it('says the row is only hidden here, and why, when settlement cannot reach it', () => {
    mount([owned]);
    act(() => actions.dismiss(owned));
    expect(notices().map((toast) => toast.message)).toEqual([
      'Hidden on this device. It is still running.',
    ]);
    act(() => actions.dismiss({ ...owned, lifecycleLabel: 'Needs attention' }));
    expect(notices().map((toast) => toast.message)).toEqual([
      'Hidden on this device. It still needs you.',
    ]);
  });

  it('says Marked done when there is no settlement to fall short of', () => {
    work.supported = false;
    mount([owned]);
    act(() => actions.dismiss(owned));
    expect(notices().map((toast) => toast.message)).toEqual(['Marked done']);
  });

  it('shows only the error when a settle fails, never an Undo', async () => {
    work.change.mutateAsync.mockRejectedValueOnce(new Error('refused'));
    mount([owned]);
    await act(async () => {
      actions.settle('owned', true);
      await Promise.resolve();
    });
    expect(work.change.mutateAsync).toHaveBeenCalledWith({
      conversationId: 'owned',
      settled: true,
    });
    expect(notices()).toEqual([]);
  });

  it('offers Undo once the settle succeeds, and Undo reopens it', async () => {
    work.change.mutateAsync.mockResolvedValueOnce(undefined);
    mount([owned]);
    await act(async () => {
      actions.settle('owned', true);
      await Promise.resolve();
    });
    expect(notices().map((toast) => toast.message)).toEqual(['Marked done']);
    act(() => {
      expect(undoLatestAction()).toBe(true);
    });
    expect(work.change.mutate).toHaveBeenCalledWith({
      conversationId: 'owned',
      settled: false,
    });
  });
});

// Mark done puts the conversation away; it is not Discard draft. The person's
// unsent text and quotes for that chat stay where they were, on every path:
// the local dismissal, the host hide and the synced settle.
describe('Mark done and the chat’s unsent draft', () => {
  const QUOTE = {
    version: 1 as const,
    origin: 'http://localhost',
    sessionId: 'owned',
    turnId: 'turn-1',
    messageId: 'message-1',
    revision: 'a'.repeat(64),
    excerpt: 'a line worth keeping',
  };
  const withTab: HomeWorkItem = { ...owned, chatSessionId: 'owned-tab' };
  const seed = () => {
    for (const key of ['owned', 'owned-tab']) {
      chatDraftsStore.clear(key);
      chatDraftsStore.set(key, 'Unsent words');
      chatDraftsStore.addQuote(key, { ...QUOTE, sessionId: key });
    }
  };
  const expectKept = () => {
    for (const key of ['owned', 'owned-tab']) {
      expect(chatDraftsStore.get(key)).toBe('Unsent words');
      expect(chatDraftsStore.getQuotes(key)).toHaveLength(1);
    }
  };

  it('leaves the text and quotes alone on every Mark done path', async () => {
    work.change.mutateAsync.mockResolvedValue(undefined);
    mount([withTab]);
    for (const hideSupported of [false, true]) {
      work.hideSupported = hideSupported;
      seed();
      act(() => actions.dismiss(withTab));
      expectKept();
    }
    seed();
    await act(async () => {
      actions.settle('owned', true);
      await Promise.resolve();
    });
    expectKept();
    for (const key of ['owned', 'owned-tab']) chatDraftsStore.clear(key);
  });
});

describe('the one latest notice', () => {
  it('replaces an earlier notice from any inbox action, bulk and discard included', () => {
    mount([owned]);
    act(() => {
      offerInboxUndo('2 marked done', vi.fn());
    });
    act(() => {
      offerInboxUndo('Draft discarded', vi.fn());
    });
    expect(notices().map((toast) => toast.message)).toEqual([
      'Draft discarded',
    ]);
  });

  it('closes when the Station changes, so its Undo is not offered elsewhere', () => {
    const view = mount([owned]);
    act(() => {
      offerInboxUndo('2 marked done', vi.fn());
    });
    expect(notices()).toHaveLength(1);
    station.apiBase = 'http://other';
    view.rerender(
      <InboxDismissUndo>
        <Probe items={[owned]} />
      </InboxDismissUndo>,
    );
    expect(notices()).toEqual([]);
    expect(undoLatestAction()).toBe(false);
  });
});

describe('Reopen after a hide moved to the host', () => {
  it('unhides on the host even before this device has read the hidden record', () => {
    // The local dismissal was just moved to the host and dropped here; the
    // host's read has not come back yet, so `hidden` is still empty.
    work.hidden = {};
    mount([external]);
    act(() => actions.restore(external));
    expect(work.hide.mutate).toHaveBeenCalledWith({
      sessionId: 'external-thread',
      hidden: false,
    });
  });
});
