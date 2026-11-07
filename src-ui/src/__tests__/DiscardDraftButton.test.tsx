// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dispatch = vi.hoisted(() => vi.fn());
const authority = vi.hoisted(() => ({
  current: true,
  scope: undefined as
    | { apiBase: string; authorityKey: string; isCurrent(): boolean }
    | undefined,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => authority.scope,
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  dispatchOrchestrationCommandWithReceipt: dispatch,
}));

import { DiscardDraftButton } from '../components/drafts/DiscardDraftButton';

let cache: QueryClient;
const button = (title = 'Draft A', onDiscarded = vi.fn()) => (
  <DiscardDraftButton
    threadId="draft-a"
    title={title}
    className="discard"
    onDiscarded={onDiscarded}
  />
);
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={cache}>{children}</QueryClientProvider>
);

async function clickDiscard(title = 'Draft A') {
  fireEvent.click(
    screen.getByRole('button', { name: `Discard draft ${title}` }),
  );
  await act(async () => {});
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  cache = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  dispatch.mockReset();
  dispatch.mockResolvedValue({ receipt: { status: 'accepted' }, result: null });
  authority.current = true;
  authority.scope = {
    apiBase: 'https://station.test',
    authorityKey: 'person-a',
    isCurrent: () => authority.current,
  };
});

afterEach(() => {
  cleanup();
  cache.clear();
  vi.useRealTimers();
});

describe('draft discard recovery', () => {
  it('offers Undo before any server deletion and cancels the pending discard', async () => {
    render(button(), { wrapper });
    await clickDiscard();
    expect(screen.getByRole('status').textContent).toContain(
      'Draft will be discarded',
    );
    await advance(7999);
    expect(dispatch).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole('button', { name: 'Undo discard of Draft A' }),
    );
    await advance(10000);

    expect(dispatch).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Discard draft Draft A' }),
    );
  });

  it('dispatches once after the window, even when another host offers the same draft', async () => {
    const discarded = vi.fn();
    const invalidate = vi.spyOn(cache, 'invalidateQueries');
    render(
      <>
        {button('Draft A', discarded)}
        {button('Same draft elsewhere')}
      </>,
      { wrapper },
    );
    await clickDiscard();
    await clickDiscard('Same draft elsewhere');

    await advance(8000);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      { type: 'discardDraft', threadId: 'draft-a' },
      'https://station.test',
      undefined,
      { requestScope: authority.scope },
    );
    expect(discarded).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['orchestration-sessions'],
    });
  });

  it('cancels an Undo window when its surface unmounts', async () => {
    const view = render(button(), { wrapper });
    await clickDiscard();
    view.unmount();

    await advance(8000);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps late success bookkeeping but does not call a retired surface', async () => {
    let resolveCommand!: (value: unknown) => void;
    dispatch.mockReturnValue(
      new Promise((resolve) => {
        resolveCommand = resolve;
      }),
    );
    const discarded = vi.fn();
    const invalidate = vi.spyOn(cache, 'invalidateQueries');
    const view = render(button('Draft A', discarded), { wrapper });
    await clickDiscard();
    await advance(8000);
    expect(dispatch).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () => {
      resolveCommand({ receipt: { status: 'accepted' }, result: null });
    });
    expect(discarded).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['orchestration-sessions'],
    });
  });

  it('cancels when authority expires before dispatch, even without a render', async () => {
    render(button(), { wrapper });
    await clickDiscard();
    authority.current = false;

    await advance(8000);

    expect(dispatch).not.toHaveBeenCalled();
  });

  it('keeps the successor authority Undo window visible when an older cancellation settles', async () => {
    const view = render(button(), { wrapper });
    await clickDiscard();
    authority.scope = {
      apiBase: 'https://other-station.test',
      authorityKey: 'person-b',
      isCurrent: () => true,
    };
    view.rerender(button());
    await clickDiscard();

    expect(
      screen.getByRole('button', { name: 'Undo discard of Draft A' }),
    ).toBeTruthy();
    await advance(8000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][1]).toBe('https://other-station.test');
  });

  it('shows a refusal after dispatch and keeps the draft available', async () => {
    dispatch.mockRejectedValue(
      Object.assign(new Error('This draft is starting. Try again.'), {
        code: 'draft_busy',
      }),
    );
    const discarded = vi.fn();
    render(button('Draft A', discarded), { wrapper });
    await clickDiscard();

    await advance(8000);

    expect(screen.getByRole('alert').textContent).toBe(
      'This draft is starting. Try again.',
    );
    expect(discarded).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole('button', { name: 'Discard draft Draft A' })
        .getAttribute('aria-disabled'),
    ).toBeNull();
  });
});
