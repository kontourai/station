/** @vitest-environment jsdom */

import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  closeSessionInventoryOccurrence,
  openSessionInventoryOccurrence,
  readSessionInventoryHostRegistration,
  useSessionInventoryOccurrence,
  useSessionInventoryHostRegistration,
} from '../sessionInventoryOccurrence';

const hooks = vi.hoisted(() => ({
  fallback: vi.fn(),
  registerLiveBinding: vi.fn(),
}));

vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'handoff-test',
  }),
}));
vi.mock('../sessionInventoryLiveBinding', () => ({
  registerSessionInventoryLiveBinding: (...args: unknown[]) => {
    hooks.registerLiveBinding(...args);
    return () => {};
  },
}));
vi.mock('../SessionInventoryCompact', () => ({
  SessionInventoryCompact: ({
    onOpenFull,
  }: {
    onOpenFull(trigger: HTMLElement, selection: unknown): void;
  }) => (
    <aside aria-label="Chat inventory">
      <button
        type="button"
        onClick={(event) =>
          onOpenFull(event.currentTarget, {
            scope: { kind: 'whole-session', sessionId: 'session-a' },
            groupId: 'inputs',
          })
        }
      >
        Open full Basis
      </button>
    </aside>
  ),
}));
vi.mock('../SessionInventoryFullFallback', () => ({
  SessionInventoryFullFallback: (props: unknown) => {
    hooks.fallback(props);
    return <div aria-label="Basis" role="dialog" />;
  },
}));

import { SessionInventoryHost } from '../SessionInventoryHost';

afterEach(() => {
  closeSessionInventoryOccurrence();
  hooks.fallback.mockReset();
  hooks.registerLiveBinding.mockReset();
});

const scope = { kind: 'whole-session' as const, sessionId: 'session-a' };

function renderHost(options: { isMobile?: boolean } = {}) {
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.textContent = 'Chat inventory';
  document.body.appendChild(trigger);
  const onClose = vi.fn();
  const result = render(
    <SessionInventoryHost
      scope={scope}
      chatStoreId="chat-a"
      hostId="host-a"
      trigger={trigger}
      isMobile={options.isMobile ?? false}
      dockMode="bottom"
      fullscreen={false}
      onClose={onClose}
    />,
  );
  return { ...result, onClose, trigger };
}

describe('SessionInventoryHost', () => {
  test('an exact answer survives current-execution refresh but closes for another chat or unmount', () => {
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const input = {
      hostId: 'refresh-host',
      chatStoreId: 'chat-a',
      executionId: 'execution-a',
      mountRef: { current: mount },
      executionRead: 'present',
      dockMode: 'bottom' as const,
      fullscreen: false,
    };
    const view = renderHook(
      ({ chatStoreId, executionId }) =>
        useSessionInventoryHostRegistration(
          'refresh-host',
          'handoff-test',
          chatStoreId,
          executionId,
        ),
      { initialProps: input },
    );
    const occurrence = renderHook(() =>
      useSessionInventoryOccurrence('refresh-host'),
    );
    act(() => {
      expect(
        openSessionInventoryOccurrence({
          hostId: 'refresh-host',
          authorityKey: 'handoff-test',
          activeSessionId: 'chat-a',
          executionSessionId: 'execution-a',
          executionRead: 'present',
          trigger: null,
          requestedScope: {
            kind: 'current-answer',
            sessionId: 'execution-a',
            turnId: 'turn-a',
          },
        }),
      ).toBe(true);
    });
    view.rerender({ ...input, executionId: 'execution-b' });
    expect(occurrence.result.current?.requestedScope).toEqual({
      kind: 'current-answer',
      sessionId: 'execution-a',
      turnId: 'turn-a',
    });
    expect(
      readSessionInventoryHostRegistration('refresh-host')?.executionId,
    ).toBe('execution-b');
    view.rerender({ ...input, chatStoreId: 'another-chat' });
    expect(occurrence.result.current).toBeNull();
    view.unmount();
    expect(
      readSessionInventoryHostRegistration('refresh-host'),
    ).toBeUndefined();
    mount.remove();
  });

  test('replaces compact inventory with the full fallback and returns focus to the invoking control on close', () => {
    const { onClose, trigger } = renderHost();

    fireEvent.click(screen.getByRole('button', { name: 'Open full Basis' }));

    expect(screen.queryByLabelText('Chat inventory')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Basis' })).not.toBeNull();
    const fallback = hooks.fallback.mock.lastCall?.[0] as {
      forceFallback?: boolean;
      onClose?(): void;
    };
    expect(fallback.forceFallback).toBeUndefined();

    act(() => fallback.onClose?.());

    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(trigger);
  });

  test('keeps phone inventory as its one full fallback sheet', () => {
    renderHost({ isMobile: true });

    expect(screen.queryByLabelText('Chat inventory')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Basis' })).not.toBeNull();
    const fallback = hooks.fallback.mock.lastCall?.[0] as {
      forceFallback?: boolean;
    };
    expect(fallback.forceFallback).toBe(true);
  });

  test('re-activating a hosted full pane focuses it instead of remounting compact inventory', () => {
    const { trigger } = renderHost();
    fireEvent.click(screen.getByRole('button', { name: 'Open full Basis' }));
    const fallback = hooks.fallback.mock.lastCall?.[0] as {
      onHostOpened?(focus: () => boolean): void;
    };
    const focus = vi.fn(() => false);

    act(() => fallback.onHostOpened?.(focus));

    expect(
      (
        trigger as HTMLElement & { focusFullBasis?: () => boolean }
      ).focusFullBasis?.(),
    ).toBe(false);
    expect(focus).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText('Chat inventory')).toBeNull();
  });
});
