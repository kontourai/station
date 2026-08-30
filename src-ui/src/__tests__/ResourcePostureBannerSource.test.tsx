// @vitest-environment jsdom

import { _setApiBase } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BannerHost } from '../components/notifications/BannerHost';
import { ResourcePostureBannerSource } from '../components/notifications/ResourcePostureBannerSource';
import { bannerStore } from '../contexts/banner-store';

/**
 * archive#3089: the UI half of "route -> query -> rendered state". Only
 * `fetch` is stubbed here — `useResourcePostureQuery` (the real SDK hook),
 * `fetchResourcePosture`, and `ResourcePostureBannerSource` all run for
 * real, so this proves the component renders exactly the value the (mocked)
 * server response carried, not a value it invented independently. The
 * mocked JSON body is the identical envelope
 * `src-server/routes/system/__tests__/resource-posture-routes.test.ts`
 * proves the real route returns for the same posture object.
 */
function mockResourcePostureResponse(data: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/system/resource-posture')) {
        return new Response(JSON.stringify({ success: true, data }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function renderChrome() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ResourcePostureBannerSource />
      <BannerHost />
    </QueryClientProvider>,
  );
}

describe('ResourcePostureBannerSource', () => {
  beforeEach(() => {
    _setApiBase('http://example.test');
    bannerStore.reset();
  });

  afterEach(() => {
    bannerStore.reset();
    vi.restoreAllMocks();
  });

  it('renders no indicator for healthy posture', async () => {
    mockResourcePostureResponse({
      kind: 'healthy',
      busyPercent: 12,
      cpuCount: 8,
      sampledAt: 1,
      sampleMs: 500,
      thresholdPercent: 85,
      source: 'test',
    });

    renderChrome();

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders no indicator when the probe is unavailable (fails open, not a user incident)', async () => {
    mockResourcePostureResponse({
      kind: 'unavailable',
      cpuCount: 0,
      sampledAt: null,
      sampleMs: null,
      thresholdPercent: 85,
      source: 'test',
    });

    renderChrome();

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders sustained critical posture with the averaged window, age, and interactive/automatic distinction', async () => {
    mockResourcePostureResponse({
      kind: 'critical',
      busyPercent: 99,
      smoothedBusyPercent: 97,
      windowLength: 5,
      ageMs: 3_000,
      cpuCount: 8,
      sampledAt: 1,
      sampleMs: 500,
      thresholdPercent: 95,
      source: 'test',
    });

    renderChrome();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/very busy/i);
    expect(alert.textContent).toMatch(/97% CPU busy/);
    expect(alert.textContent).toMatch(/averaged across 5 samples/i);
    expect(alert.textContent).toMatch(/observed 3s ago/i);
    expect(alert.textContent).toMatch(/automatic work is paused/i);
    expect(alert.textContent).toMatch(/explicit starts ask before continuing/i);
    expect(screen.getByTestId('banner-host').className).toMatch(
      /banner-host--critical-chrome/,
    );
  });

  it('renders a degraded banner distinguishable from the critical wording', async () => {
    mockResourcePostureResponse({
      kind: 'degraded',
      busyPercent: 90,
      cpuCount: 8,
      sampledAt: 1,
      sampleMs: 500,
      thresholdPercent: 85,
      source: 'test',
    });

    renderChrome();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/busy/i);
    expect(alert.textContent).toMatch(/90% CPU busy/);
    expect(alert.textContent).not.toMatch(/very busy/i);
    expect(alert.textContent).not.toMatch(/new engine starts are refused/i);
    expect(alert.textContent).toMatch(/automatic work is paused/i);
    expect(screen.getByTestId('banner-host').className).toMatch(
      /banner-host--critical-chrome/,
    );
  });
});
