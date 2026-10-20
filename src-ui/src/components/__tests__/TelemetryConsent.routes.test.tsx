/** @vitest-environment jsdom */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '@kontourai/station-contracts/config';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  request: vi.fn(),
  save: vi.fn(),
  config: {} as AppConfig,
}));
vi.mock('@kontourai/station-sdk', () => ({
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
    const reconfigure = vi.spyOn(service, 'reconfigure');
    const app = new Hono();
    app.route(
      '/config',
      withOperatorPrincipal(
        // Positional and untyped here (see serverModule): the callback is
        // `onAppConfigPersisted`, the last parameter.
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
