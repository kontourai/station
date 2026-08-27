/** @vitest-environment jsdom */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { lazy } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DeferredCapabilityBoundary } from '../components/DeferredCapabilityBoundary';
import { BannerHost } from '../components/notifications/BannerHost';
import {
  BANNER_IDS,
  BANNER_PRIORITY,
  bannerStore,
} from '../contexts/banner-store';
import { EXTENSIONS_UNAVAILABLE_LABEL } from '../core/pluginRegistryCopy';

const connection = vi.hoisted(() => ({
  status: 'connected' as 'connected' | 'connecting' | 'error',
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnectionStatus: () => ({ status: connection.status }),
}));

const copy = {
  failureTitle: 'Connection recovery is unavailable',
  failure: 'Station could not start connection recovery.',
};

function BrokenCapability(): never {
  throw new Error('broken deferred capability');
}

describe('DeferredCapabilityBoundary', () => {
  afterEach(() => {
    cleanup();
    connection.status = 'connected';
    bannerStore.reset();
    vi.restoreAllMocks();
  });

  test('keeps loading silent while the shell stays mounted', () => {
    const Never = lazy(() => new Promise<never>(() => {}));

    render(
      <>
        <main>Usable Station workspace</main>
        <DeferredCapabilityBoundary id="connection-recovery" copy={copy}>
          <Never />
        </DeferredCapabilityBoundary>
        <BannerHost />
      </>,
    );

    expect(screen.getByText('Usable Station workspace')).toBeTruthy();
    expect(bannerStore.getSnapshot()).toEqual([]);
    expect(screen.queryByTestId('banner-host')).toBeNull();
    // An empty store is not silence: a Suspense fallback rendering its own
    // notice bypasses the store entirely, which is exactly the hand-rolled
    // surface this issue retired. Assert nothing is announced at all.
    expect(
      document.querySelector('[data-deferred-capability-pending]'),
    ).not.toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('keeps the shell mounted and presents a failed capability through the banner store', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <>
        <main>Usable Station workspace</main>
        <DeferredCapabilityBoundary id="connection-recovery" copy={copy}>
          <BrokenCapability />
        </DeferredCapabilityBoundary>
        <BannerHost />
      </>,
    );

    expect(screen.getByText('Usable Station workspace')).toBeTruthy();
    await waitFor(() => expect(bannerStore.getSnapshot()).toHaveLength(1));
    expect(bannerStore.getSnapshot()[0]).toMatchObject({
      id: `${BANNER_IDS.deferredCapability}:connection-recovery`,
      priority: BANNER_PRIORITY.capabilityFailure,
      tone: 'error',
      badge: copy.failureTitle,
      message: copy.failure,
      dismissible: false,
    });
    expect(screen.getByRole('button', { name: 'Reload Station' })).toBeTruthy();
  });

  test('reports a rejected import as persistent capability failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Failing = lazy(() => Promise.reject(new Error('chunk unavailable')));

    render(
      <>
        <main>Usable Station workspace</main>
        <DeferredCapabilityBoundary id="connection-recovery" copy={copy}>
          <Failing />
        </DeferredCapabilityBoundary>
        <BannerHost />
      </>,
    );

    await waitFor(() => expect(bannerStore.getSnapshot()).toHaveLength(1));
    expect(bannerStore.getSnapshot()[0]?.message).toBe(copy.failure);
    expect(screen.getByText('Usable Station workspace')).toBeTruthy();
  });

  test('keeps an outage-caused import failure quiet and retries it automatically after reconnect', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    connection.status = 'error';
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('host unavailable'))
      .mockResolvedValueOnce({
        default: () => <div>Recovered capability</div>,
      });

    const view = render(
      <>
        <DeferredCapabilityBoundary
          id="connection-recovery"
          copy={copy}
          load={load}
        />
        <BannerHost />
      </>,
    );

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    await act(async () => undefined);
    expect(bannerStore.getSnapshot()).toEqual([]);

    connection.status = 'connected';
    view.rerender(
      <>
        <DeferredCapabilityBoundary
          id="connection-recovery"
          copy={copy}
          load={load}
        />
        <BannerHost />
      </>,
    );

    expect(await screen.findByText('Recovered capability')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
    expect(bannerStore.getSnapshot()).toEqual([]);
  });

  test('keeps a genuine import failure loud when the connection is healthy', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const load = vi.fn().mockRejectedValue(new Error('broken bundle'));

    render(
      <>
        <DeferredCapabilityBoundary
          id="connection-recovery"
          copy={copy}
          load={load}
        />
        <BannerHost />
      </>,
    );

    await waitFor(() => expect(bannerStore.getSnapshot()).toHaveLength(1));
    expect(bannerStore.getSnapshot()[0]?.badge).toBe(copy.failureTitle);
    expect(screen.getByRole('button', { name: 'Reload Station' })).toBeTruthy();
  });

  test('keeps two failed boundary instances in independent banners', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const extensionCopy = {
      failureTitle: EXTENSIONS_UNAVAILABLE_LABEL,
      failure: 'Station could not start the extension registry.',
    };

    render(
      <>
        <DeferredCapabilityBoundary id="connection-recovery" copy={copy}>
          <BrokenCapability />
        </DeferredCapabilityBoundary>
        <DeferredCapabilityBoundary
          id="extension-registry"
          copy={extensionCopy}
        >
          <BrokenCapability />
        </DeferredCapabilityBoundary>
        <BannerHost />
      </>,
    );

    await waitFor(() => expect(bannerStore.getSnapshot()).toHaveLength(2));
    expect(bannerStore.getSnapshot().map((banner) => banner.id)).toEqual([
      `${BANNER_IDS.deferredCapability}:connection-recovery`,
      `${BANNER_IDS.deferredCapability}:extension-registry`,
    ]);
    // station#3308: the host collapses the stack — front banner plus a cap
    // for the second; expanding renders both as independent banners.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('banner-stack-cap'));
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });

  test('dismisses its failure banner on unmount', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = render(
      <DeferredCapabilityBoundary id="connection-recovery" copy={copy}>
        <BrokenCapability />
      </DeferredCapabilityBoundary>,
    );

    await waitFor(() => expect(bannerStore.getSnapshot()).toHaveLength(1));
    view.unmount();
    expect(bannerStore.getSnapshot()).toEqual([]);
  });
});
