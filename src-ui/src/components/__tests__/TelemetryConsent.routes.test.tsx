/** @vitest-environment jsdom */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '@kontourai/station-contracts/config';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  request: vi.fn(),
  save: vi.fn(),
  config: {} as AppConfig,
}));
vi.mock('@kontourai/station-sdk', () => ({
  mutateJson: (url: string, method: string, _options: unknown, body: unknown) =>
    bridge.request(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  authenticatedFetch: (url: string, init?: RequestInit) =>
    bridge.request(url, init),
  useConfigQuery: () => ({ data: bridge.config }),
  useUpdateConfigMutation: () => ({
    isPending: false,
    mutate: (
      value: AppConfig,
      handlers: {
        onSuccess: (result: unknown) => void;
        onError: (error: unknown) => void;
      },
    ) => bridge.save(value).then(handlers.onSuccess, handlers.onError),
  }),
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('../../hooks/useRecoveryConfig', () => ({
  useRecoveryConfig: () => ({ data: undefined }),
  recoveryConfigKey: (...parts: unknown[]) => parts,
}));
vi.mock('../../contexts/RecoveryQueryBoundary', () => ({
  useOptionalRecoveryScope: () => null,
}));
vi.mock('../../../../src-server/telemetry/metrics.js', () => ({
  configOps: { add: vi.fn() },
  usageTelemetryOutcomes: { add: vi.fn() },
}));

// Server owners compile in their own lane; load the real fixture without
// adding the server-only dependency graph to the browser typecheck.
const serverModule = (path: string) => `../../../../src-server/${path}`;
const { withOperatorPrincipal } = await import(
  serverModule('__test-utils__/operator-principal.js')
);
const { trackTempDirs } = await import(
  serverModule('__test-utils__/temp-dirs.js')
);
const { ConfigLoader } = await import(serverModule('domain/config-loader.js'));
const { createUsageTelemetryDisclosureRoutes } = await import(
  serverModule('routes/operations/usage-telemetry-disclosure.js')
);
const { createConfigRoutes } = await import(
  serverModule('routes/system/config.js')
);
const { UsageTelemetryService } = await import(
  serverModule('services/usage-telemetry-service.js')
);
const { createLogger } = await import(serverModule('utils/logger.js'));

import { StationConfigSection } from '../../views/settings/StationConfigSection';
import { UsageTelemetryDisclosureStep } from '../UsageTelemetryDisclosure';

const makeTempDir = trackTempDirs();

test.each(['full', 'lite'] as const)(
  'declining %s through the real dialog and routes persists Off before acknowledgement and never sends',
  async (tier) => {
    const home = makeTempDir('station-consent-ui-');
    const loader = new ConfigLoader({
      projectHomeDir: home,
      watchFiles: false,
    });
    await loader.loadAppConfig();
    bridge.config = await loader.updateAppConfig({
      telemetryTier: { operator: tier, kontour: 'off' },
      productTelemetryEndpoint: 'https://receiver.test/v1/product/events',
    });
    const fetch = vi.fn();
    const logger = createLogger({
      name: 'telemetry-consent-test',
      level: 'error',
    });
    const service = new UsageTelemetryService({
      homeDir: home,
      appConfig: bridge.config,
      version: '1.2.3',
      logger,
      env: {},
      fetch,
    });
    const app = new Hono();
    app.route(
      '/config',
      withOperatorPrincipal(
        createConfigRoutes(
          loader,
          logger,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          (config: AppConfig) => service.reconfigure(config),
        ),
      ),
    );
    app.route(
      '/api/usage-telemetry',
      createUsageTelemetryDisclosureRoutes(service),
    );
    bridge.request.mockImplementation((url: string, init?: RequestInit) =>
      app.request(new URL(url).pathname, init),
    );
    bridge.save.mockImplementation(async (config: AppConfig) => {
      const response = await app.request('/config/app', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(config),
      });
      expect(response.status).toBe(200);
      const result = await response.json();
      bridge.config = result.data;
      return result;
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const advance = vi.fn();
    const view = render(
      <QueryClientProvider client={client}>
        <UsageTelemetryDisclosureStep onAdvance={advance} />
      </QueryClientProvider>,
    );
    try {
      if (tier === 'full')
        expect(
          await screen.findByText(
            /Your saved operator choice is Full, awaiting acknowledgement/,
          ),
        ).toBeTruthy();
      else
        expect(
          await screen.findByRole('button', {
            name: 'Allow Full usage telemetry',
          }),
        ).toBeTruthy();
      fireEvent.click(
        screen.getByRole('button', { name: 'Turn off usage telemetry' }),
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));
      await waitFor(() => expect(advance).toHaveBeenCalledOnce());
      const persisted = JSON.parse(
        await readFile(join(home, 'config', 'app.json'), 'utf8'),
      );
      expect(persisted.telemetryTier.operator).toBe('off');
      expect(persisted).not.toHaveProperty('telemetryEnabled');
      expect((await service.disclosure()).acknowledged).toBe(true);
      await service.track('station_started', {
        version: '1.2.3',
        platform: process.platform,
        arch: process.arch,
      });
      await service.flush();
      expect(fetch).not.toHaveBeenCalled();
      // Settings uses the same writer; both publishers survive a fresh loader read.
      view.unmount();
      const settings = render(
        <StationConfigSection
          containerScope="station"
          section="telemetry"
          config={bridge.config}
          onChange={(config) => {
            void bridge.save({ telemetryTier: config.telemetryTier });
          }}
        />,
      );
      expect(
        (
          screen.getByRole('combobox', {
            name: 'Operator telemetry',
          }) as HTMLSelectElement
        ).value,
      ).toBe('off');
      fireEvent.change(
        screen.getByRole('combobox', { name: 'Kontour telemetry' }),
        { target: { value: 'lite' } },
      );
      await waitFor(() =>
        expect(bridge.config.telemetryTier?.kontour).toBe('lite'),
      );
      const restarted = new ConfigLoader({
        projectHomeDir: home,
        watchFiles: false,
      });
      try {
        expect((await restarted.loadAppConfig()).telemetryTier).toEqual({
          kontour: 'lite',
          operator: 'off',
        });
      } finally {
        restarted.dispose();
        settings.unmount();
      }
    } finally {
      view.unmount();
      client.clear();
      loader.dispose();
    }
  },
);

afterEach(() => vi.restoreAllMocks());

async function publisherFixture(doNotTrack?: string) {
  const home = makeTempDir('station-telemetry-ui-');
  const loader = new ConfigLoader({ projectHomeDir: home, watchFiles: false });
  await loader.loadAppConfig();
  bridge.config = await loader.updateAppConfig({
    telemetryTier: { operator: 'lite', kontour: 'off' },
    productTelemetryEndpoint: 'https://receiver.test/events',
  });
  const sent: unknown[] = [];
  const tiersAtSend: string[] = [];
  const logger = createLogger({ name: 'telemetry-ui-routes', level: 'error' });
  const service = new UsageTelemetryService({
    homeDir: home,
    appConfig: bridge.config,
    version: '1.2.3',
    logger,
    env: doNotTrack ? { DO_NOT_TRACK: doNotTrack } : {},
    fetch: async (_url: string, init: RequestInit) => {
      tiersAtSend.push((await loader.loadAppConfig()).telemetryTier?.operator);
      sent.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    },
  });
  const app = new Hono();
  app.route(
    '/config',
    withOperatorPrincipal(
      createConfigRoutes(
        loader,
        logger,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        (updated: AppConfig) => service.reconfigure(updated),
        (publisher: 'kontour' | 'operator', reason: 'privacy' | 'skip') =>
          service.recordTierLowering(publisher, reason),
      ),
    ),
  );
  app.route(
    '/api/usage-telemetry',
    createUsageTelemetryDisclosureRoutes(service),
  );
  bridge.request.mockImplementation((url: string, init?: RequestInit) =>
    app.request(new URL(url).pathname + new URL(url).search, init),
  );
  bridge.save.mockImplementation(async (config: AppConfig) => {
    const response = await app.request('/config/app', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    bridge.config = result.data;
    return result;
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return { home, loader, service, client, sent, tiersAtSend };
}

import { TelemetryOutbox } from '../../views/settings/TelemetryOutbox';
import { TelemetryLiteNotice } from '../TelemetryLiteNotice';

test.each([undefined, '1'])(
  'the real lowering dialog sends an optional reason in the config write before Off; DNT=%s',
  async (dnt) => {
    const fixture = await publisherFixture(dnt);
    const { client, loader, service, sent, tiersAtSend } = fixture;
    const advance = vi.fn();
    const view = render(
      <QueryClientProvider client={client}>
        <UsageTelemetryDisclosureStep onAdvance={advance} />
      </QueryClientProvider>,
    );
    try {
      if (dnt) {
        fireEvent.click(await screen.findByRole('radio', { name: 'Off' }));
        fireEvent.click(
          screen.getByRole('button', { name: 'Save operator choice as Off' }),
        );
        expect(screen.queryByText(/Why lower Operator/)).toBeNull();
      } else {
        fireEvent.click(
          await screen.findByRole('button', {
            name: 'Turn off usage telemetry',
          }),
        );
        expect((await loader.loadAppConfig()).telemetryTier.operator).toBe(
          'lite',
        );
        fireEvent.click(await screen.findByRole('button', { name: 'Privacy' }));
      }
      await waitFor(() => expect(advance).toHaveBeenCalledOnce());
      expect((await loader.loadAppConfig()).telemetryTier.operator).toBe('off');
      expect(sent).toEqual(
        dnt
          ? []
          : [
              {
                publisher: 'operator',
                action: 'tier-lowered',
                reason: 'privacy',
              },
            ],
      );
      expect(tiersAtSend).toEqual(dnt ? [] : ['lite']);
      expect((await service.disclosure()).acknowledged).toBe(!dnt);
    } finally {
      view.unmount();
      client.clear();
      loader.dispose();
    }
  },
);

test('notice receipts follow visible presentation, survive remount, and require a new inventory; hidden notices never attest', async () => {
  const { client, loader, service, home } = await publisherFixture();
  bridge.request.mockClear();
  const rect = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({
      top: 100,
      bottom: 300,
      height: 200,
      left: 0,
      right: 390,
      width: 390,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });
  const modal = document.createElement('div');
  modal.setAttribute('aria-modal', 'true');
  document.body.append(modal);
  const renderNotice = (enabled = true) =>
    render(
      <QueryClientProvider client={client}>
        <TelemetryLiteNotice enabled={enabled} />
      </QueryClientProvider>,
    );
  let view = renderNotice(false);
  try {
    expect((await service.telemetryStatus()).liteNotices).toEqual({});
    view.unmount();
    view = renderNotice();
    await screen.findByRole('complementary', {
      name: 'Lite telemetry notice for Operator',
    });
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    expect(
      bridge.request.mock.calls.filter(([url]) =>
        String(url).endsWith('/lite-notices'),
      ),
    ).toHaveLength(0);
    expect((await service.telemetryStatus()).liteNotices).toEqual({});
    modal.remove();
    await waitFor(async () =>
      expect(
        (await service.telemetryStatus()).liteNotices.operator
          ?.inventoryRevision,
      ).toBe((await service.telemetryStatus()).liteInventoryRevision),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notice' }));
    view.unmount();
    view = renderNotice();
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    // A stale receipt is not a notice for today's catalog.
    const dailyPath = join(home, 'config', 'telemetry-daily.json');
    const daily = JSON.parse(await readFile(dailyPath, 'utf8'));
    daily.notices.operator.inventoryRevision = 'old-revision';
    await writeFile(dailyPath, JSON.stringify(daily));
    view.unmount();
    client.clear();
    view = renderNotice();
    await screen.findByRole('complementary', {
      name: 'Lite telemetry notice for Operator',
    });
    await waitFor(async () =>
      expect(
        (await service.telemetryStatus()).liteNotices.operator
          ?.inventoryRevision,
      ).not.toBe('old-revision'),
    );
  } finally {
    modal.remove();
    view.unmount();
    client.clear();
    loader.dispose();
    rect.mockRestore();
  }
});

test('outbox displays sent JSON but never exposes dropped payload bytes, and is scoped and bounded', async () => {
  const { client, loader, home } = await publisherFixture();
  // Adversarial ledger data tests the UI outcome boundary, including a malformed dropped body.
  const entry = {
    publisher: 'operator',
    tier: 'lite',
    recordedAt: new Date().toISOString(),
    outcome: 'sent',
    reason: 'acknowledged',
    payload: { event: 'telemetry_dropped', count: 1 },
  };
  await writeFile(
    join(home, 'config', 'telemetry-outbox.json'),
    JSON.stringify([
      ...Array.from({ length: 55 }, (_, index) => ({
        ...entry,
        payload: { event: 'station_daily', event_id: `sent-${index}` },
      })),
      {
        ...entry,
        publisher: 'kontour',
        payload: { secret: 'other-publisher-payload' },
      },
      {
        ...entry,
        outcome: 'dropped',
        reason: 'transport',
        payload: { secret: 'dropped-secret-must-not-render' },
      },
      {
        ...entry,
        outcome: 'dropped',
        reason: 'notice',
        payload: { event: 'telemetry_dropped', count: 4 },
      },
    ]),
  );
  const view = render(
    <QueryClientProvider client={client}>
      <TelemetryOutbox publisher="operator" />
    </QueryClientProvider>,
  );
  try {
    await screen.findByText('4 observations');
    expect(screen.getAllByRole('listitem')).toHaveLength(50);
    expect(screen.getByText('Suppressed')).toBeTruthy();
    expect(screen.getByText('Dropped')).toBeTruthy();
    fireEvent.click(screen.getAllByText('View sent payload JSON')[0]);
    expect(screen.getByText(/sent-54/)).toBeTruthy();
    expect(view.container.textContent).not.toContain('dropped-secret');
    expect(view.container.textContent).not.toContain('other-publisher-payload');
    view.unmount();
    client.clear();
    const empty = render(
      <QueryClientProvider client={client}>
        <TelemetryOutbox publisher="kontour" />
      </QueryClientProvider>,
    );
    await screen.findByText(/View sent payload JSON/);
    await writeFile(join(home, 'config', 'telemetry-outbox.json'), '[]');
    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh Kontour outbox' }),
    );
    await screen.findByText("This publisher's outbox is empty.");
    empty.unmount();
  } finally {
    view.unmount();
    client.clear();
    loader.dispose();
  }
});

test('DNT never renders a Lite notice or records a UI receipt', async () => {
  const { client, loader, service } = await publisherFixture('1');
  const view = render(
    <QueryClientProvider client={client}>
      <TelemetryLiteNotice />
    </QueryClientProvider>,
  );
  try {
    await waitFor(() =>
      expect(
        client.getQueryState([
          'telemetry-status',
          'http://station.test',
          undefined,
        ])?.status,
      ).toBe('success'),
    );
    expect(screen.queryByRole('complementary')).toBeNull();
    expect((await service.telemetryStatus()).liteNotices).toEqual({});
  } finally {
    view.unmount();
    client.clear();
    loader.dispose();
  }
});
