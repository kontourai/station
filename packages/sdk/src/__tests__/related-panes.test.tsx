/** @vitest-environment jsdom */
import type { PaneRelatedPanesHost } from '@kontourai/station-contracts/workspace-pane-host-contract';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { SDKContext, type SDKContextValue } from '../providers';
import { createRelatedPanesPaneHost, useRelatedPanes } from '../related-panes';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

const HANDLE = `plugin-pane:${'a'.repeat(32)}`;

function transport() {
  const iframe = document.createElement('iframe');
  document.body.append(iframe);
  const target = iframe.contentWindow as Window;
  const post = vi.spyOn(target, 'postMessage');
  const host = createRelatedPanesPaneHost(target, 'https://station.test');
  const reply = (
    data: { method: string; params: Record<string, unknown> },
    source: Window = target,
    origin = 'https://station.test',
  ) =>
    window.dispatchEvent(new MessageEvent('message', { source, origin, data }));
  const sent = (index = 0) =>
    post.mock.calls[index]?.[0] as {
      method: string;
      params: { id: string } & Record<string, unknown>;
    };
  return { host, reply, sent, post };
}

describe('the frame client for related panes', () => {
  test('settles only from the pinned host window and origin, with the result its id names', async () => {
    const { host, reply, sent, post } = transport();
    try {
      const opening = host.open({
        descriptorId: 'pane:plugin%3Areports:detail',
        modeId: 'project',
        key: 'weekly',
      });
      expect(sent().method).toBe('pane-host/related-open');
      expect(sent().params.request).toEqual({
        descriptorId: 'pane:plugin%3Areports:detail',
        modeId: 'project',
        key: 'weekly',
      });
      expect(post.mock.calls[0]?.[1]).toBe('https://station.test');
      const result = (handle: string) => ({
        method: 'pane-host/related-result',
        params: {
          id: sent().params.id,
          data: { status: 'opened', handle, presentation: 'beside' },
        },
      });
      // Forgeries first, each with its own answer: a sibling window, then the
      // right window at the wrong origin. Only the pinned pair settles it.
      reply(result(`plugin-pane:${'b'.repeat(32)}`), window);
      reply(
        result(`plugin-pane:${'c'.repeat(32)}`),
        undefined,
        'https://other.test',
      );
      reply(result(HANDLE));
      await expect(opening).resolves.toEqual({
        status: 'opened',
        handle: HANDLE,
        presentation: 'beside',
      });
    } finally {
      host.dispose();
    }
  });

  test('a host answer outside the contract reads as refused, and a target as plain data', async () => {
    const { host, reply, sent } = transport();
    try {
      const reveal = host.reveal(HANDLE);
      reply({
        method: 'pane-host/related-result',
        params: {
          id: sent(0).params.id,
          data: { status: 'focused', presentation: 'fullscreen', extra: 1 },
        },
      });
      await expect(reveal).resolves.toEqual({
        status: 'unavailable',
        reason: 'refused',
      });
      const target = host.target();
      reply({
        method: 'pane-host/related-result',
        params: {
          id: sent(1).params.id,
          data: {
            descriptorId: 'pane:plugin%3Areports:detail',
            modeId: 'project',
            key: 'weekly',
            injected: '<script>',
          },
        },
      });
      await expect(target).resolves.toEqual({
        descriptorId: 'pane:plugin%3Areports:detail',
        modeId: 'project',
        key: 'weekly',
      });
    } finally {
      host.dispose();
    }
  });

  test('an older host refuses the method by name, which settles as unsupported', async () => {
    const { host, reply } = transport();
    try {
      const closing = host.close(HANDLE);
      reply({
        method: 'pane-host/refused',
        params: {
          method: 'pane-host/related-close',
          reason: 'method is not a pane-host capability',
        },
      });
      await expect(closing).resolves.toEqual({
        status: 'unavailable',
        reason: 'unsupported',
      });
    } finally {
      host.dispose();
    }
  });

  test('an unanswered request and a disposed client settle rather than reject', async () => {
    vi.useFakeTimers();
    const { host } = transport();
    const unanswered = host.open({
      descriptorId: 'pane:plugin%3Areports:detail',
      modeId: 'project',
      key: 'weekly',
    });
    vi.advanceTimersByTime(30_000);
    await expect(unanswered).resolves.toEqual({
      status: 'unavailable',
      reason: 'refused',
    });
    const pending = host.target();
    host.dispose();
    await expect(pending).resolves.toBeNull();
    await expect(host.reveal(HANDLE)).resolves.toEqual({
      status: 'unavailable',
      reason: 'refused',
    });
  });
});

describe('useRelatedPanes', () => {
  function withHost(relatedPanes?: PaneRelatedPanesHost) {
    const value = {
      apiBase: '',
      contexts: {},
      hooks: {},
      ...(relatedPanes ? { relatedPanes } : {}),
    } satisfies SDKContextValue;
    return ({ children }: { children: ReactNode }) => (
      <SDKContext.Provider value={value}>{children}</SDKContext.Provider>
    );
  }

  test('an older host answers every request unsupported, never rejecting', async () => {
    const { result } = renderHook(() => useRelatedPanes(), {
      wrapper: withHost(),
    });
    expect(result.current.supported).toBe(false);
    await expect(
      result.current.open({ descriptorId: 'd', modeId: 'm', key: 'k' }),
    ).resolves.toEqual({ status: 'unavailable', reason: 'unsupported' });
    await expect(result.current.target()).resolves.toBeNull();
  });

  test('a host that offers the capability is the one a pane calls', async () => {
    const host: PaneRelatedPanesHost = {
      version: 1,
      open: vi.fn(async () => ({
        status: 'opened' as const,
        handle: HANDLE,
        presentation: 'beside' as const,
      })),
      reveal: vi.fn(),
      close: vi.fn(),
      target: vi.fn(async () => null),
    };
    const { result } = renderHook(() => useRelatedPanes(), {
      wrapper: withHost(host),
    });
    expect(result.current.supported).toBe(true);
    await result.current.open({ descriptorId: 'd', modeId: 'm', key: 'k' });
    expect(host.open).toHaveBeenCalledWith({
      descriptorId: 'd',
      modeId: 'm',
      key: 'k',
    });
  });
});
