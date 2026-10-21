/** @vitest-environment jsdom */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '@kontourai/station-contracts/config';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { Hono } from 'hono';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const build = vi.hoisted(() => ({ endpoint: '' }));
vi.mock('../../../../src-server/domain/telemetry-build-constants.js', () => ({
  get STATION_AUTHOR_TELEMETRY_ENDPOINT() {
    return build.endpoint;
  },
}));

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
vi.mock('../../contexts/ConfigContext', () => ({
  useConfig: () => bridge.config,
  useConfigSettled: () => true,
  useConfigActions: () => ({
    updateConfig: vi.fn(),
    recordFirstRunDecision: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock('../../contexts/onboarding-setup-store', () => ({
  useOnboardingSetupState: () => ({ launcherWouldShow: false }),
  firstRunChapterPresence: { set: vi.fn() },
}));
vi.mock('../../hooks/useSystemStatus', () => ({
  useSystemStatus: () => ({ isFetching: false }),
}));
vi.mock('../first-run/EnginesStep', () => ({
  useFirstRunEngineOptions: () => ({ options: [], settled: true }),
  FirstRunEnginesChapter: () => null,
}));
vi.mock('../first-run/AboutYouStep', () => ({ AboutYouStep: () => null }));
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
import { FirstRunHomeChapter } from '../first-run/FirstRunHomeChapter';
import { firstRunStore } from '../first-run/first-run-store';
import { SHARING_LABELS } from '../UsageSharingChoices';
import {
  resetUsageTelemetryDisclosureDismissal,
  UsageTelemetryDisclosure,
  UsageTelemetryDisclosureStep,
} from '../UsageTelemetryDisclosure';

const makeTempDir = trackTempDirs();

async function publisherFixture(
  doNotTrack?: string,
  endpointFromEnv?: string,
  options: { choices?: AppConfig['telemetryTier']; endpoint?: false } = {},
) {
  const home = makeTempDir('station-telemetry-ui-');
  const loader = new ConfigLoader({ projectHomeDir: home, watchFiles: false });
  await loader.loadAppConfig();
  bridge.config = await loader.updateAppConfig({
    telemetryTier: options.choices ?? { operator: 'lite', kontour: 'lite' },
    ...(endpointFromEnv || options.endpoint === false
      ? {}
      : { productTelemetryEndpoint: 'https://receiver.test/events' }),
  });
  const sent: unknown[] = [];
  const tiersAtSend: string[] = [];
  const logger = createLogger({ name: 'telemetry-ui-routes', level: 'error' });
  const env: NodeJS.ProcessEnv = doNotTrack ? { DO_NOT_TRACK: doNotTrack } : {};
  if (endpointFromEnv) env.STATION_PRODUCT_TELEMETRY_ENDPOINT = endpointFromEnv;
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
        (updated: AppConfig) => service.reconfigure(updated),
        (publisher: 'kontour' | 'operator', reason: 'privacy' | 'skip') =>
          service.recordTierLowering(publisher, reason),
        () => service.canSaveAuthorFull(),
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
  bridge.request.mockClear();
  bridge.save.mockClear();
  bridge.scopedRead.mockClear();
  resetUsageTelemetryDisclosureDismissal();
  firstRunStore.reset();
  bridge.scope = null;
  build.endpoint = '';
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
        kontour: tier,
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

test.each([
  ['full', 'off'],
  ['lite', 'off'],
  ['off', 'full'],
  ['lite', 'lite'],
] as const)(
  'under DNT, changing saved %s to %s uses the combined surface without acknowledging',
  async (previous, tier) => {
    const { client, loader, service } = await publisherFixture('1', undefined, {
      choices: { kontour: previous, operator: previous },
    });
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
      expect((await loader.loadAppConfig()).telemetryTier).toEqual({
        kontour: tier,
        operator: tier,
      });
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

test.each([undefined, '1'])(
  'an unconfigured home with both choices off does not reopen the prompt (DNT %s)',
  async (dnt) => {
    const { client, loader, service } = await publisherFixture(dnt, undefined, {
      choices: { kontour: 'off', operator: 'off' },
      endpoint: false,
    });
    const view = mountChoice(client, vi.fn(), true);
    try {
      await waitFor(() =>
        expect(calls('/api/usage-telemetry/status').length).toBeGreaterThan(0),
      );
      await waitFor(() => expect(client.isFetching()).toBe(0));
      expect((await service.disclosure()).endpointConfigured).toBe(false);
      expect(
        screen.queryByRole('dialog', { name: 'Usage sharing' }),
      ).toBeNull();
    } finally {
      view.unmount();
      client.clear();
      loader.dispose();
    }
  },
);

test.each(['hidden', 'covered', 'offscreen'] as const)(
  'dismissal cannot record a notice from an unseen %s surface',
  async (hidden) => {
    const { client, loader, service } = await publisherFixture();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: hidden === 'offscreen' ? -400 : 100,
      bottom: hidden === 'offscreen' ? -200 : 300,
      height: 200,
      left: 0,
      right: 390,
      width: 390,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });
    if (hidden === 'hidden')
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const cover = document.createElement('div');
    cover.setAttribute('aria-modal', 'true');
    if (hidden === 'covered') document.body.append(cover);
    const view = mountChoice(client, vi.fn(), true);
    try {
      await screen.findByRole('dialog');
      fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect((await service.telemetryStatus()).liteNotices).toEqual({});
      expect(calls('/lite-notices')).toHaveLength(0);
    } finally {
      cover.remove();
      view.unmount();
      client.clear();
      loader.dispose();
    }
  },
);

test.each([false, true])(
  'Detailed acknowledges both configured destinations before saving; author refusal %s',
  async (refuse) => {
    build.endpoint = 'https://kontour.test/counts';
    const { client, loader, service, sent } = await publisherFixture();
    const refusedBeforeReview = await bridge.request(
      'http://station.test/config/app',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ telemetryTier: { kontour: 'full' } }),
      },
    );
    expect(refusedBeforeReview.status).toBe(400);
    expect((await refusedBeforeReview.json()).error).toBe(
      "The current confirmation for sharing detailed usage with Kontour is missing. Review what's included and save your choice.",
    );
    expect((await loader.loadAppConfig()).telemetryTier?.kontour).toBe('lite');
    const request = bridge.request.getMockImplementation()!;
    if (refuse)
      bridge.request.mockImplementation((url: string, init?: RequestInit) => {
        if (
          url.endsWith('/acknowledgements') &&
          JSON.parse(String(init?.body)).publisher === 'kontour'
        )
          return Promise.resolve(new Response(null, { status: 403 }));
        return request(url, init);
      });
    const advance = vi.fn();
    const view = mountChoice(client, advance);
    try {
      const detailed = await screen.findByRole('radio', {
        name: SHARING_LABELS.full,
      });
      await waitFor(() => expect(detailed).toHaveProperty('disabled', false));
      fireEvent.click(detailed);
      await screen.findByText('Shared with Kontour at: kontour.test');
      bridge.request.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
      if (refuse) {
        await screen.findByRole('alert', { name: 'Sharing choice error' });
        expect(advance).not.toHaveBeenCalled();
        expect((await loader.loadAppConfig()).telemetryTier).toEqual({
          kontour: 'lite',
          operator: 'lite',
        });
        expect(calls('/config/app')).toHaveLength(0);
        expect(calls('/lite-notices')).toHaveLength(0);
      } else {
        await waitFor(() => expect(advance).toHaveBeenCalledOnce());
        const acknowledgements = calls('/acknowledgements');
        expect(acknowledgements).toHaveLength(2);
        expect(JSON.parse(acknowledgements[0][1].body)).toMatchObject({
          publisher: 'kontour',
          destination: build.endpoint,
          inventoryRevision: (await service.disclosure()).inventoryRevision,
          acknowledgementProtocol: 2,
        });
        expect((await service.disclosure('kontour')).acknowledged).toBe(true);
        expect((await service.disclosure()).acknowledged).toBe(true);
        expect((await loader.loadAppConfig()).telemetryTier).toEqual({
          kontour: 'full',
          operator: 'full',
        });
        const order = bridge.request.mock.calls.map(([url]) => String(url));
        expect(
          order.lastIndexOf(
            'http://station.test/api/usage-telemetry/disclosure/acknowledgements',
          ),
        ).toBeLessThan(order.indexOf('http://station.test/config/app'));
        await service.track('station_started', {
          version: '1.2.3',
          platform: process.platform,
          arch: process.arch,
        });
        await service.flush();
        expect(sent).toHaveLength(2);
      }
    } finally {
      view.unmount();
      client.clear();
      loader.dispose();
    }
  },
);

test('a counts choice under Do Not Track still needs a visible notice when tracking protection ends', async () => {
  const { client, loader, service, env } = await publisherFixture('1');
  const advance = vi.fn();
  const view = mountChoice(client, advance);
  try {
    await screen.findByRole('region', { name: 'Do Not Track' });
    fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
    await waitFor(() => expect(advance).toHaveBeenCalledOnce());
    view.unmount();
    expect((await service.telemetryStatus()).liteNotices).toEqual({});
    delete env.DO_NOT_TRACK;
    await service.reconfigure(await loader.loadAppConfig());
    client.clear();
    const next = mountChoice(client, vi.fn(), true);
    await screen.findByRole('dialog', { name: 'Usage sharing' });
    expect(
      screen.getByRole('radio', { name: SHARING_LABELS.lite }),
    ).toHaveProperty('checked', true);
    next.unmount();
  } finally {
    view.unmount();
    client.clear();
    loader.dispose();
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
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
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

test('an open prompt resets Detailed when Do Not Track changes before saving', async () => {
  const { client, loader, service, env } = await publisherFixture('1');
  const view = mountChoice(client, vi.fn());
  try {
    await screen.findByRole('region', { name: 'Do Not Track' });
    fireEvent.click(screen.getByRole('radio', { name: SHARING_LABELS.full }));
    expect(
      screen.getByRole('radio', { name: SHARING_LABELS.full }),
    ).toHaveProperty('checked', true);
    delete env.DO_NOT_TRACK;
    await service.reconfigure(await loader.loadAppConfig());
    await client.invalidateQueries({ queryKey: ['telemetry-status'] });
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Do Not Track' })).toBeNull(),
    );
    expect(
      screen.getByRole('radio', { name: SHARING_LABELS.lite }),
    ).toHaveProperty('checked', true);
    expect((await service.disclosure()).acknowledged).toBe(false);
  } finally {
    view.unmount();
    client.clear();
    loader.dispose();
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

test('an environment-configured additional destination discloses only its host, never its URL path', async () => {
  const { client, loader, service } = await publisherFixture(
    undefined,
    'https://receiver.test:8443/private-path',
  );
  const view = mountChoice(client, vi.fn(), true);
  try {
    await screen.findByText('Also shared with: receiver.test:8443');
    expect((await service.disclosure()).additionalHost).toBe(
      'receiver.test:8443',
    );
    expect(screen.getByRole('dialog').textContent).not.toMatch(/private-path/);
    fireEvent.click(screen.getByRole('radio', { name: SHARING_LABELS.full }));
    expect(
      screen.getByRole('region', { name: "What's included" }).textContent,
    ).toContain('definition version');
    expect(
      screen.getByRole('region', { name: "What's included" }).textContent,
    ).toContain('retry code');
  } finally {
    view.unmount();
    client.clear();
    loader.dispose();
  }
});

test('Advanced controls keep independent saved choices through the real config route', async () => {
  const { client, loader, service } = await publisherFixture();
  const status = await service.telemetryStatus();
  const view = render(
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
  try {
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
    build.endpoint = '';
  }
});

test.each([undefined, '1'])(
  'reopened mixed choices remain unchanged until a radio is selected (DNT %s)',
  async (dnt) => {
    const choices = { kontour: 'off', operator: 'lite' } as const;
    const { client, loader } = await publisherFixture(dnt, undefined, {
      choices,
    });
    const view = mountChoice(client, vi.fn(), true);
    try {
      const first = await screen.findByRole('radio', {
        name: SHARING_LABELS.off,
      });
      await waitFor(() => expect(first).toHaveProperty('disabled', false));
      expect(
        screen
          .getAllByRole('radio')
          .filter((radio) => (radio as HTMLInputElement).checked),
      ).toHaveLength(0);
      await waitFor(() => expect(document.activeElement).toBe(first));
      expect(screen.getByText(/current choices differ/i)).toBeTruthy();
      const save = screen.getByRole('button', { name: 'Save choice' });
      expect(save).toHaveProperty('disabled', true);
      bridge.request.mockClear();
      fireEvent.keyDown(first, { key: 'Enter', code: 'Enter' });
      fireEvent.click(save);
      await waitFor(() => expect(client.isMutating()).toBe(0));
      expect(calls('/config/app')).toHaveLength(0);
      expect((await loader.loadAppConfig()).telemetryTier).toEqual(choices);
    } finally {
      view.unmount();
      client.clear();
      loader.dispose();
    }
  },
);

test('reopened Detailed with stale confirmation keeps Detailed selected and renews it on Save', async () => {
  const { client, loader, service } = await publisherFixture(
    undefined,
    undefined,
    { choices: { kontour: 'full', operator: 'full' } },
  );
  const view = mountChoice(client, vi.fn(), true);
  try {
    expect((await service.disclosure()).acknowledged).toBe(false);
    const detailed = await screen.findByRole('radio', {
      name: SHARING_LABELS.full,
    });
    await waitFor(() => expect(detailed).toHaveProperty('disabled', false));
    expect(detailed).toHaveProperty('checked', true);
    await waitFor(() => expect(document.activeElement).toBe(detailed));
    fireEvent.keyDown(detailed, { key: 'Enter', code: 'Enter' });
    expect((await loader.loadAppConfig()).telemetryTier).toEqual({
      kontour: 'full',
      operator: 'full',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
    await waitFor(async () =>
      expect((await service.disclosure()).acknowledged).toBe(true),
    );
    await waitFor(() => expect(client.isMutating()).toBe(0));
    expect((await loader.loadAppConfig()).telemetryTier).toEqual({
      kontour: 'full',
      operator: 'full',
    });
  } finally {
    view.unmount();
    client.clear();
    loader.dispose();
  }
});

test('fresh choices preselect Anonymous and initially focus that radio', async () => {
  const { client, loader } = await publisherFixture(undefined, undefined, {
    choices: {},
  });
  const view = mountChoice(client, vi.fn(), true);
  try {
    const anonymous = await screen.findByRole('radio', {
      name: SHARING_LABELS.lite,
    });
    await waitFor(() => expect(anonymous).toHaveProperty('disabled', false));
    expect(anonymous).toHaveProperty('checked', true);
    await waitFor(() => expect(document.activeElement).toBe(anonymous));
  } finally {
    view.unmount();
    client.clear();
    loader.dispose();
  }
});

test.each(['off', 'dismiss'] as const)(
  'reading a visible dialog past the daily flush does not send; interaction %s',
  async (action) => {
    vi.useFakeTimers({
      toFake: [
        'Date',
        'setInterval',
        'clearInterval',
        'requestAnimationFrame',
        'cancelAnimationFrame',
      ],
    });
    vi.setSystemTime('2026-10-12T10:00:00Z');
    const { client, loader, service, sent } = await publisherFixture();
    await service.track('client_connected', {
      surface: 'web',
      device_class: 'other',
      version: 'custom',
    });
    vi.setSystemTime('2026-10-13T10:00:00Z');
    await service.track('client_connected', {
      surface: 'web',
      device_class: 'other',
      version: 'custom',
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
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
    let resumeChoice: (() => void) | undefined;
    try {
      await screen.findByRole('dialog');
      await vi.waitFor(() => expect(client.isFetching()).toBe(0));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(40);
      });
      vi.setSystemTime('2026-10-13T10:00:00Z');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000);
      });
      expect(calls('/lite-notices')).toHaveLength(0);
      expect((await service.telemetryStatus()).liteNotices).toEqual({});
      expect(sent).toHaveLength(0);
      if (action === 'off') {
        const gate = new Promise<void>((resolve) => {
          resumeChoice = resolve;
        });
        let started!: () => void;
        const entered = new Promise<void>((resolve) => {
          started = resolve;
        });
        let writeResponse: Promise<Response> | undefined;
        const request = bridge.request.getMockImplementation()!;
        bridge.request.mockImplementation((url: string, init?: RequestInit) => {
          if (url.endsWith('/config/app') && init?.method === 'PUT') {
            started();
            writeResponse = (async () => {
              await gate;
              return request(url, init);
            })();
            return writeResponse;
          }
          return request(url, init);
        });
        fireEvent.click(
          screen.getByRole('radio', { name: SHARING_LABELS.off }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
        await entered;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(12_000);
        });
        expect((await service.telemetryStatus()).liteNotices).toEqual({});
        expect(sent).toHaveLength(0);
        fireEvent.click(
          screen.getByRole('button', { name: 'Close usage sharing' }),
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(12_000);
        });
        expect((await service.telemetryStatus()).liteNotices).toEqual({});
        expect(sent).toHaveLength(0);
        resumeChoice!();
        expect((await writeResponse!).status).toBe(200);
      } else fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
      const now = new Date();
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(async () =>
        expect(
          Object.keys((await service.telemetryStatus()).liteNotices),
        ).toHaveLength(2),
      );
      expect(
        Object.keys((await service.telemetryStatus()).liteNotices).sort(),
      ).toEqual(['kontour', 'operator']);
      await service.flushDaily();
      expect(sent).toHaveLength(action === 'off' ? 0 : 1);
      expect((await loader.loadAppConfig()).telemetryTier).toEqual({
        kontour: action === 'off' ? 'off' : 'lite',
        operator: action === 'off' ? 'off' : 'lite',
      });
    } finally {
      resumeChoice?.();
      view.unmount();
      client.clear();
      loader.dispose();
      await service.shutdown();
      vi.useRealTimers();
    }
  },
);

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  'Detailed copy remains plain in first-run and main Settings with real fields (DNT %s, mixed %s)',
  async (dnt, mixed) => {
    const choices = mixed
      ? ({ kontour: 'off', operator: 'lite' } as const)
      : ({ kontour: 'lite', operator: 'lite' } as const);
    const { client, loader, service } = await publisherFixture(
      dnt ? '1' : undefined,
      undefined,
      { choices },
    );
    const view = mountChoice(client, vi.fn(), true);
    try {
      await screen.findByRole('dialog');
      fireEvent.click(screen.getByRole('radio', { name: SHARING_LABELS.full }));
      expect(
        screen.getByRole('region', { name: "What's included" }).textContent,
      ).toContain('retry code');
      expect(screen.getByRole('dialog').textContent).not.toMatch(
        /\b(Lite|Full|publisher|operator|inventory|receipt)\b/i,
      );
      view.unmount();
      const status = await service.telemetryStatus();
      const disclosure = await service.disclosure();
      function CopySettings() {
        const [draft, setDraft] = useState(bridge.config);
        return (
          <StationConfigSection
            section="telemetry"
            containerScope="station"
            config={draft}
            telemetryPublishers={status.publishers}
            telemetryDisclosure={disclosure}
            telemetryCounts={status.liteInventory}
            onChange={(patch) =>
              setDraft((current) => ({ ...current, ...patch }))
            }
          />
        );
      }
      const settings = render(
        <QueryClientProvider client={client}>
          <CopySettings />
        </QueryClientProvider>,
      );
      try {
        const main = screen.getByLabelText('Usage sharing choices');
        if (dnt)
          expect(
            screen.getByRole('region', { name: 'Do Not Track' }),
          ).toBeTruthy();
        if (mixed) expect(main.textContent).toContain('Custom choices');
        expect(main.textContent).not.toMatch(
          /\b(Lite|Full|publisher|operator|inventory|receipt)\b/i,
        );
        fireEvent.click(
          screen.getByRole('radio', { name: SHARING_LABELS.full }),
        );
        expect(
          screen.getByRole('region', { name: "What's included" }).textContent,
        ).toContain('retry code');
        expect(main.textContent).not.toMatch(
          /\b(Lite|Full|publisher|operator|inventory|receipt)\b/i,
        );
      } finally {
        settings.unmount();
      }
    } finally {
      view.unmount();
      client.clear();
      loader.dispose();
    }
  },
);

test('notice failure after Save preserves the preference and reports only the notice failure', async () => {
  const { client, loader, service, sent } = await publisherFixture();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
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
  const request = bridge.request.getMockImplementation()!;
  bridge.request.mockImplementation((url: string, init?: RequestInit) =>
    url.endsWith('/lite-notices')
      ? Promise.resolve(new Response(null, { status: 503 }))
      : request(url, init),
  );
  const view = mountChoice(client, vi.fn(), true);
  try {
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('radio', { name: SHARING_LABELS.off }));
    fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
    await screen.findByText(
      /Your sharing choice was saved, but the notice could not be saved/,
    );
    expect((await loader.loadAppConfig()).telemetryTier).toEqual({
      kontour: 'off',
      operator: 'off',
    });
    expect((await service.telemetryStatus()).liteNotices).toEqual({});
    await service.flushDaily();
    expect(sent).toHaveLength(0);
    expect(
      screen.queryByText('Your sharing choice could not be saved. Try again.'),
    ).toBeNull();
  } finally {
    view.unmount();
    client.clear();
    loader.dispose();
    await service.shutdown();
  }
});

test.each(['close', 'escape', 'backdrop'] as const)(
  'guided first-run %s records an explicit visible dismissal and preserves choices',
  async (exit) => {
    const { client, loader, service } = await publisherFixture();
    bridge.config = { ...bridge.config, firstRun: { status: 'pending' } };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 300,
      right: 500,
      width: 500,
      height: 300,
      toJSON() {},
    });
    const view = render(
      <QueryClientProvider client={client}>
        <FirstRunHomeChapter intentFirst />
      </QueryClientProvider>,
    );
    try {
      const dialog = await screen.findByRole('dialog');
      const anonymous = await screen.findByRole('radio', {
        name: /Anonymous usage counts/,
      });
      await waitFor(() => expect(document.activeElement).toBe(anonymous));
      expect(calls('/lite-notices')).toHaveLength(0);
      if (exit === 'close')
        fireEvent.click(screen.getByRole('button', { name: 'Close setup' }));
      else if (exit === 'escape') fireEvent.keyDown(dialog, { key: 'Escape' });
      else fireEvent.pointerDown(screen.getByRole('presentation'));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await waitFor(async () =>
        expect(
          Object.keys((await service.telemetryStatus()).liteNotices),
        ).toHaveLength(2),
      );
      expect((await loader.loadAppConfig()).telemetryTier).toEqual({
        kontour: 'lite',
        operator: 'lite',
      });
      expect(
        calls('/config/app').filter(([, init]) => init?.method === 'PUT'),
      ).toHaveLength(0);
    } finally {
      view.unmount();
      client.clear();
      await service.shutdown();
      loader.dispose();
    }
  },
);

test.each(['full', 'lite'] as const)(
  'declining initial %s saves Off without a Full acknowledgement and survives Settings restart',
  async (previous) => {
    const { home, loader, service, client, sent } = await publisherFixture(
      undefined,
      undefined,
      { choices: { operator: previous, kontour: 'off' } },
    );
    const reconfigure = vi.spyOn(service, 'reconfigure');
    const advance = vi.fn();
    const view = mountChoice(client, advance);
    let settings: ReturnType<typeof render> | undefined;
    try {
      fireEvent.click(
        await screen.findByRole('radio', { name: SHARING_LABELS.off }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Save choice' }),
        ).toHaveProperty('disabled', false),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save choice' }));
      await waitFor(() => expect(advance).toHaveBeenCalledOnce());
      expect(reconfigure).toHaveBeenCalledWith(
        expect.objectContaining({
          telemetryTier: expect.objectContaining({ operator: 'off' }),
        }),
      );
      const persisted = JSON.parse(
        await readFile(join(home, 'config', 'app.json'), 'utf8'),
      );
      expect(persisted.telemetryTier.operator).toBe('off');
      expect(persisted).not.toHaveProperty('telemetryEnabled');
      expect(calls('/acknowledgements')).toHaveLength(0);
      expect((await service.disclosure()).acknowledged).toBe(false);
      expect((await service.telemetryStatus()).publishers.operator.tier).toBe(
        'off',
      );
      await service.track('station_started', {
        version: '1.2.3',
        platform: process.platform,
        arch: process.arch,
      });
      await service.flush();
      expect(sent).toHaveLength(0);
      view.unmount();
      bridge.config = await loader.loadAppConfig();
      const status = await service.telemetryStatus();
      settings = render(
        <QueryClientProvider client={client}>
          <StationConfigSection
            containerScope="station"
            section="telemetry"
            config={bridge.config}
            telemetryPublishers={status.publishers}
            onChange={(config) => {
              void bridge.save({ telemetryTier: config.telemetryTier });
            }}
          />
        </QueryClientProvider>,
      );
      const details = screen.getByText('Advanced', { exact: true })
        .parentElement!;
      details.setAttribute('open', '');
      fireEvent(details, new Event('toggle'));
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
      }
    } finally {
      settings?.unmount();
      view.unmount();
      client.clear();
      loader.dispose();
    }
  },
);
