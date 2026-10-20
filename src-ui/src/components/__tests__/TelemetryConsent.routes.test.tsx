/** @vitest-environment jsdom */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '@kontourai/station-contracts/config';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  request: vi.fn(),
  scopedRead: vi.fn(),
  scope: null as RecoveryScope | null,
  save: vi.fn(),
  config: {} as AppConfig,
}));
vi.mock('@kontourai/station-sdk', () => ({
  getJson: (...args: unknown[]) => bridge.scopedRead(...args),
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
  useOptionalRecoveryScope: () => bridge.scope,
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

import type { RecoveryScope } from '../../contexts/RecoveryQueryBoundary';
import { StationConfigSection } from '../../views/settings/StationConfigSection';
import { SHARING_LABELS } from '../UsageSharingChoices';
import {
  resetUsageTelemetryDisclosureDismissal,
  UsageTelemetryDisclosure,
  UsageTelemetryDisclosureStep,
} from '../UsageTelemetryDisclosure';

const makeTempDir = trackTempDirs();

async function publisherFixture(doNotTrack?: string) {
  const home = makeTempDir('station-telemetry-ui-');
  const loader = new ConfigLoader({ projectHomeDir: home, watchFiles: false });
  await loader.loadAppConfig();
  bridge.config = await loader.updateAppConfig({
    telemetryTier: { operator: 'lite', kontour: 'lite' },
    productTelemetryEndpoint: 'https://receiver.test/events',
  });
  const sent: unknown[] = [];
  const tiersAtSend: string[] = [];
  const logger = createLogger({ name: 'telemetry-ui-routes', level: 'error' });
  const env: NodeJS.ProcessEnv = doNotTrack ? { DO_NOT_TRACK: doNotTrack } : {};
  const service = new UsageTelemetryService({
    homeDir: home,
    appConfig: bridge.config,
    version: '1.2.3',
    logger,
    env,
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
  return { home, loader, service, client, sent, tiersAtSend, env };
}

import { TelemetryOutbox } from '../../views/settings/TelemetryOutbox';

beforeEach(() => {
  resetUsageTelemetryDisclosureDismissal();
  bridge.scope = null;
});
afterEach(() => vi.restoreAllMocks());

function mountChoice(client: QueryClient, advance = vi.fn(), dialog = false) {
  return render(
    <QueryClientProvider client={client}>
      {dialog ? (
        <UsageTelemetryDisclosure firstRun />
      ) : (
        <UsageTelemetryDisclosureStep onAdvance={advance} />
      )}
    </QueryClientProvider>,
  );
}

const calls = (suffix: string) =>
  bridge.request.mock.calls.filter(([url]) => String(url).endsWith(suffix));

test.each(['off', 'lite', 'full'] as const)(
  'the shared choice saves %s through real routes; detailed consent precedes activation',
  async (tier) => {
    const { client, loader, service, sent, tiersAtSend } =
      await publisherFixture();
    const advance = vi.fn();
    const view = mountChoice(client, advance);
    try {
      const anonymous = await screen.findByRole('radio', {
        name: /^Anonymous usage counts/,
      });
      expect(anonymous).toHaveProperty('checked', true);
      fireEvent.click(
        screen.getByRole('radio', { name: SHARING_LABELS[tier] }),
      );
      if (tier === 'full')
        expect(
          screen.getByRole('region', { name: "What's included" }),
        ).toBeTruthy();
      bridge.request.mockClear();
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Save choice' }),
        ).toHaveProperty('disabled', false),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
      await waitFor(() => expect(advance).toHaveBeenCalledOnce());
      const saved = await loader.loadAppConfig();
      expect(saved.telemetryTier).toEqual({
        kontour: tier === 'full' ? 'lite' : tier,
        operator: tier,
      });
      expect((await service.disclosure()).acknowledged).toBe(tier === 'full');
      const ordered = bridge.request.mock.calls.map(([url]) => String(url));
      if (tier === 'full') {
        expect(
          ordered.findIndex((url) => url.endsWith('/acknowledgements')),
        ).toBeGreaterThanOrEqual(0);
        expect(
          ordered.findIndex((url) => url.endsWith('/acknowledgements')),
        ).toBeLessThan(ordered.findIndex((url) => url.endsWith('/config/app')));
      } else expect(calls('/acknowledgements')).toHaveLength(0);
      expect((await service.telemetryStatus()).publishers.operator.tier).toBe(
        tier,
      );
      await service.track('station_started', {
        version: '1.2.3',
        platform: process.platform,
        arch: process.arch,
      });
      await service.flush();
      expect(sent).toHaveLength(tier === 'full' ? 1 : 0);
      expect(tiersAtSend).toEqual(tier === 'full' ? ['full'] : []);
    } finally {
      view.unmount();
      client.clear();
      loader.dispose();
    }
  },
);

test.each(['off', 'lite', 'full'] as const)(
  'DNT displays the shared callout and saves %s without acknowledging',
  async (tier) => {
    const { client, loader, service } = await publisherFixture('1');
    const advance = vi.fn();
    const view = mountChoice(client, advance);
    try {
      await screen.findByRole('region', { name: 'Do Not Track' });
      fireEvent.click(
        await screen.findByRole('radio', {
          name: new RegExp(`^${SHARING_LABELS[tier]}`),
        }),
      );
      bridge.request.mockClear();
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Save choice' }),
        ).toHaveProperty('disabled', false),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
      await waitFor(() => expect(advance).toHaveBeenCalledOnce());
      expect((await loader.loadAppConfig()).telemetryTier.operator).toBe(tier);
      expect((await service.telemetryStatus()).publishers.operator.tier).toBe(
        'off',
      );
      expect(calls('/acknowledgements')).toHaveLength(0);
      expect((await service.telemetryStatus()).liteNotices).toEqual({});
    } finally {
      view.unmount();
      client.clear();
      loader.dispose();
    }
  },
);

test('Not now preserves anonymous counts and records only a visibly shown notice for both destinations', async () => {
  const { client, loader, service } = await publisherFixture();
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
  const visibility = vi
    .spyOn(document, 'visibilityState', 'get')
    .mockReturnValue('hidden');
  const cover = document.createElement('div');
  cover.setAttribute('aria-modal', 'true');
  document.body.append(cover);
  const view = mountChoice(client, vi.fn(), true);
  try {
    await screen.findByRole('dialog', { name: 'Usage sharing' });
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    expect((await service.telemetryStatus()).liteNotices).toEqual({});
    cover.remove();
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    expect((await service.telemetryStatus()).liteNotices).toEqual({});
    document.body.append(cover);
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    expect((await service.telemetryStatus()).liteNotices).toEqual({});
    cover.remove();
    await waitFor(async () =>
      expect(
        Object.keys((await service.telemetryStatus()).liteNotices).sort(),
      ).toEqual(['kontour', 'operator']),
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await loader.loadAppConfig()).telemetryTier).toEqual({
      kontour: 'lite',
      operator: 'lite',
    });
    expect((await service.disclosure()).acknowledged).toBe(false);
    view.unmount();
    resetUsageTelemetryDisclosureDismissal();
    const remount = mountChoice(client, vi.fn(), true);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    remount.unmount();
  } finally {
    cover.remove();
    view.unmount();
    client.clear();
    loader.dispose();
    rect.mockRestore();
  }
});

test('a stale persisted notice requires visible presentation of the current revision', async () => {
  const { client, loader, service, home } = await publisherFixture();
  await service.recordLiteNotice(
    'operator',
    (await service.telemetryStatus()).liteInventoryRevision,
  );
  const path = join(home, 'config', 'telemetry-daily.json');
  const daily = JSON.parse(await readFile(path, 'utf8'));
  daily.notices.operator.inventoryRevision = 'old-revision';
  await writeFile(path, JSON.stringify(daily));
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
  const view = mountChoice(client, vi.fn(), true);
  try {
    await screen.findByRole('dialog', { name: 'Usage sharing' });
    await waitFor(async () =>
      expect(
        (await service.telemetryStatus()).liteNotices.operator
          ?.inventoryRevision,
      ).toBe((await service.telemetryStatus()).liteInventoryRevision),
    );
  } finally {
    view.unmount();
    client.clear();
    loader.dispose();
    rect.mockRestore();
  }
});

test('a Detailed choice saved under DNT requires a fresh explicit confirmation after DNT is removed', async () => {
  const { client, loader, service, env } = await publisherFixture('1');
  const advance = vi.fn();
  const view = mountChoice(client, advance);
  try {
    await screen.findByRole('region', { name: 'Do Not Track' });
    fireEvent.click(screen.getByRole('radio', { name: SHARING_LABELS.full }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save choice' }),
      ).toHaveProperty('disabled', false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
    await waitFor(() => expect(advance).toHaveBeenCalledOnce());
    view.unmount();
    delete env.DO_NOT_TRACK;
    await service.reconfigure(await loader.loadAppConfig());
    client.clear();
    bridge.request.mockClear();
    const next = mountChoice(client, vi.fn(), true);
    await screen.findByRole('dialog', { name: 'Usage sharing' });
    expect(
      screen.getByRole('radio', { name: SHARING_LABELS.lite }),
    ).toHaveProperty('checked', true);
    expect((await service.disclosure()).acknowledged).toBe(false);
    expect((await service.telemetryStatus()).publishers.operator.tier).toBe(
      'lite',
    );
    expect(calls('/acknowledgements')).toHaveLength(0);
    await waitFor(() =>
      expect(
        screen.getByRole('radio', { name: SHARING_LABELS.full }),
      ).toHaveProperty('disabled', false),
    );
    fireEvent.click(screen.getByRole('radio', { name: SHARING_LABELS.full }));
    fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
    await waitFor(async () =>
      expect((await service.telemetryStatus()).publishers.operator.tier).toBe(
        'full',
      ),
    );
    next.unmount();
  } finally {
    view.unmount();
    client.clear();
    loader.dispose();
  }
});

test.each(['acknowledgements', 'config/app'])(
  'a refused %s write leaves the choice open and never activates detailed sharing',
  async (suffix) => {
    const { client, loader, service } = await publisherFixture();
    const dispatch = bridge.request.getMockImplementation();
    if (!dispatch) throw new Error('Missing route fixture');
    bridge.request.mockImplementation((url: string, init?: RequestInit) =>
      String(url).endsWith(`/${suffix}`) && init?.method !== undefined
        ? new Response(JSON.stringify({ success: false }), { status: 403 })
        : dispatch(url, init),
    );
    const advance = vi.fn();
    const view = mountChoice(client, advance);
    try {
      await waitFor(() =>
        expect(
          screen.getByRole('radio', { name: SHARING_LABELS.full }),
        ).toHaveProperty('disabled', false),
      );
      fireEvent.click(screen.getByRole('radio', { name: SHARING_LABELS.full }));
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Save choice' }),
        ).toHaveProperty('disabled', false),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
      await screen.findByRole('alert');
      expect(advance).not.toHaveBeenCalled();
      expect((await loader.loadAppConfig()).telemetryTier.operator).toBe(
        'lite',
      );
      expect((await service.telemetryStatus()).publishers.operator.tier).toBe(
        'lite',
      );
    } finally {
      view.unmount();
      client.clear();
      loader.dispose();
    }
  },
);

test('first-run and main Settings use plain language; Advanced controls keep independent saved choices', async () => {
  const { client, loader, service } = await publisherFixture();
  const view = mountChoice(client, vi.fn(), true);
  try {
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('radio', { name: SHARING_LABELS.full }));
    expect(screen.getByRole('dialog').textContent).not.toMatch(
      /\b(Lite|Full|publisher|operator|inventory|receipt)\b/i,
    );
    expect(screen.getByText('Also shared with: receiver.test')).toBeTruthy();
    view.unmount();
    const status = await service.telemetryStatus();
    const settings = render(
      <QueryClientProvider client={client}>
        <StationConfigSection
          section="telemetry"
          containerScope="station"
          config={bridge.config}
          telemetryPublishers={status.publishers}
          onChange={(config) => {
            void bridge.save({ telemetryTier: config.telemetryTier });
          }}
        />
      </QueryClientProvider>,
    );
    const main = screen.getByLabelText('Usage sharing choices');
    expect(main.textContent).not.toMatch(
      /\b(Lite|Full|publisher|operator|inventory|receipt)\b/i,
    );
    fireEvent.click(screen.getByText('Advanced', { exact: true }));
    // jsdom does not implement the details activation behavior.
    const details = screen.getByText('Advanced', { exact: true })
      .parentElement!;
    details.setAttribute('open', '');
    fireEvent(details, new Event('toggle'));
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Kontour telemetry' }),
      { target: { value: 'off' } },
    );
    await waitFor(async () =>
      expect((await loader.loadAppConfig()).telemetryTier).toEqual({
        kontour: 'off',
        operator: 'lite',
      }),
    );
    settings.unmount();
  } finally {
    view.unmount();
    client.clear();
    loader.dispose();
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
    await screen.findByText('Nothing has been sent to this destination.');
    empty.unmount();
  } finally {
    view.unmount();
    client.clear();
    loader.dispose();
  }
});

test('outbox uses recovery scope and tolerates an unsent null payload', async () => {
  const { client, loader } = await publisherFixture();
  bridge.scope = {
    apiBase: 'http://recovery.test',
    identityKey: 'recovery-1',
    requestScope: {
      apiBase: 'http://recovery.test',
      authorityKey: 'captured-authority',
    },
  };
  bridge.scopedRead.mockResolvedValue(
    new Response(
      JSON.stringify({
        data: [
          {
            publisher: 'operator',
            tier: 'lite',
            recordedAt: '2026-10-18T00:00:00Z',
            outcome: 'dropped',
            reason: 'transport',
            payload: null,
          },
        ],
      }),
    ),
  );
  const view = render(
    <QueryClientProvider client={client}>
      <TelemetryOutbox publisher="operator" />
    </QueryClientProvider>,
  );
  try {
    await screen.findByText('Payload not displayed for an unsent record.');
    expect(bridge.scopedRead).toHaveBeenCalledWith(
      'http://recovery.test/api/usage-telemetry/outbox?publisher=operator&limit=50',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        requestScope: bridge.scope.requestScope,
      }),
    );
    expect(
      client.getQueryData([
        'telemetry-outbox',
        'http://recovery.test',
        'recovery-1',
        'operator',
      ]),
    ).toHaveLength(1);
  } finally {
    view.unmount();
    client.clear();
    loader.dispose();
    bridge.scope = null;
  }
});
