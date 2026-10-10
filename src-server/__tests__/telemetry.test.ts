import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createStationTempDir } from '@kontourai/station-shared/temp-dir';
import { metrics, trace } from '@opentelemetry/api';
import { MeterProvider } from '@opentelemetry/sdk-metrics';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ensureStationHomeSchemaSync } from '../domain/home-schema-gate.js';

const homes: string[] = [];
const renameHook: { afterRename?: () => Promise<void> } = {};
const readPaths: string[] = [];
const identityDelay: { beforeMkdir?: () => Promise<void> } = {};
const sdkRequire = createRequire(
  createRequire(import.meta.url).resolve('@opentelemetry/sdk-node'),
);
const { logs } = sdkRequire('@opentelemetry/api-logs') as {
  logs: {
    getLogger(name: string): { emit(record: { body: string }): void };
    disable(): void;
  };
};

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      await identityDelay.beforeMkdir?.();
      return actual.mkdir(...args);
    },
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      readPaths.push(String(args[0]));
      return actual.readFile(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      await renameHook.afterRename?.();
    },
  };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  renameHook.afterRename = undefined;
  identityDelay.beforeMkdir = undefined;
  metrics.disable();
  trace.disable();
  logs.disable();
  readPaths.length = 0;
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

async function home(): Promise<string> {
  const value = await createStationTempDir('otel');
  homes.push(value);
  ensureStationHomeSchemaSync(value);
  return value;
}

async function telemetry() {
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
  return import('../telemetry.js');
}

/** Starts configured OTel for one home and returns what reached the SDK. */
async function sdkAttributes(homeDir: string) {
  const { initializeTelemetry } = await telemetry();
  let captured: Record<string, string | Promise<string>> | undefined;
  await initializeTelemetry({
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.test' },
    homeDir,
    createSdk: (resourceAttributes) => {
      captured = { ...resourceAttributes };
      return { start: () => {}, shutdown: async () => {} };
    },
    log: () => {},
  });
  if (!captured) throw new Error('initializeTelemetry never created an SDK');
  return Object.fromEntries(
    await Promise.all(
      Object.entries(captured).map(async ([key, value]) => [key, await value]),
    ),
  );
}

describe('OTel installation identity', () => {
  test.each(['persisted', 'failed'] as const)(
    'records during identity I/O and exports only with %s identity',
    async (outcome) => {
      const root = await home();
      vi.stubEnv('STATION_HOME', root);
      vi.stubEnv('STATION_ROOT', '');
      vi.stubEnv('STATION_TELEMETRY_API_KEY', '');
      vi.stubEnv('OTEL_LOGS_EXPORTER', '');
      vi.stubEnv('OTEL_NODE_RESOURCE_DETECTORS', 'none');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const started = vi.spyOn(console, 'log').mockImplementation(() => {});
      const requests: Array<{ path: string | undefined; body: string }> = [];
      const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push({
          path: request.url,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('collector has no TCP address');
      let releaseIdentity = () => {};
      const delayed = new Promise<void>((resolve) => {
        releaseIdentity = resolve;
      });
      let markEntered = () => {};
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      identityDelay.beforeMkdir = async () => {
        markEntered();
        await delayed;
        if (outcome === 'failed')
          throw new Error('identity persistence refused');
      };
      metrics.disable();
      vi.stubEnv(
        'OTEL_EXPORTER_OTLP_ENDPOINT',
        `http://127.0.0.1:${address.port}`,
      );
      vi.stubEnv(
        'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
        `http://127.0.0.1:${address.port}/v1/logs`,
      );
      vi.stubEnv('OTEL_EXPORTER_OTLP_LOGS_PROTOCOL', 'http/json');
      const {
        configuredTelemetryShutdownTask,
        OTEL_INSTALLATION_ID_ATTRIBUTE,
      } = await import('../telemetry.js');
      try {
        await entered;
        const { chatRequests, tracer } = await import(
          '../telemetry/metrics.js'
        );
        const provider = metrics.getMeterProvider();
        if (!(provider instanceof MeterProvider))
          throw new Error(
            'configured meter was not registered during identity I/O',
          );
        chatRequests.add(7);
        tracer.startSpan('station.identity-pending-control').end();
        logs
          .getLogger('station.undeclared-signal-control')
          .emit({ body: 'not an enabled export signal' });
        const pendingExport = provider.forceFlush();
        expect(requests).toEqual([]);
        releaseIdentity();
        await pendingExport;
        if (outcome === 'failed') {
          await configuredTelemetryShutdownTask()?.shutdown(
            new AbortController().signal,
          );
          expect(warn).toHaveBeenCalledWith(
            '[telemetry] OTel did not start; Station continues without it:',
            'identity persistence refused',
          );
          expect(requests).toEqual([]);
          return;
        }
        expect(warn).not.toHaveBeenCalled();
        chatRequests.add(17);
        await provider.forceFlush();
        await configuredTelemetryShutdownTask()?.shutdown(
          new AbortController().signal,
        );
        const persisted = (
          await readFile(join(root, 'config', 'otel-installation-id'), 'utf8')
        ).trim();
        const hash = createHash('sha256').update(persisted).digest('hex');
        const observations = requests
          .filter((request) => request.path === '/v1/metrics')
          .flatMap(({ body }) => {
            const payload = JSON.parse(body) as {
              resourceMetrics: Array<{
                resource: {
                  attributes: Array<{
                    key: string;
                    value: { stringValue?: string };
                  }>;
                };
                scopeMetrics: Array<{
                  metrics: Array<{
                    name: string;
                    sum?: {
                      dataPoints: Array<{ asInt?: string; asDouble?: number }>;
                    };
                  }>;
                }>;
              }>;
            };
            return payload.resourceMetrics.flatMap((resource) => {
              expect(
                resource.resource.attributes.find(
                  (item) => item.key === OTEL_INSTALLATION_ID_ATTRIBUTE,
                )?.value.stringValue,
              ).toBe(hash);
              return resource.scopeMetrics.flatMap((scope) =>
                scope.metrics
                  .filter((metric) => metric.name === 'station.chat.requests')
                  .flatMap(
                    (metric) =>
                      metric.sum?.dataPoints.map((point) =>
                        Number(point.asInt ?? point.asDouble),
                      ) ?? [],
                  ),
              );
            });
          });
        expect(observations).toEqual([7, 17]);
        const traces = requests
          .filter((request) => request.path === '/v1/traces')
          .flatMap(({ body }) => {
            const payload = JSON.parse(body) as {
              resourceSpans: Array<{
                resource: {
                  attributes: Array<{
                    key: string;
                    value: { stringValue?: string };
                  }>;
                };
                scopeSpans: Array<{ spans: Array<{ name: string }> }>;
              }>;
            };
            return payload.resourceSpans.flatMap((resource) => {
              expect(
                resource.resource.attributes.find(
                  (item) => item.key === OTEL_INSTALLATION_ID_ATTRIBUTE,
                )?.value.stringValue,
              ).toBe(hash);
              return resource.scopeSpans.flatMap((scope) =>
                scope.spans.map((span) => span.name),
              );
            });
          });
        expect(traces).toContain('station.identity-pending-control');
        expect(requests.some((request) => request.path === '/v1/logs')).toBe(
          false,
        );
      } finally {
        releaseIdentity();
        await vi.waitFor(() => {
          if (outcome === 'failed') {
            expect(warn).toHaveBeenCalledWith(
              '[telemetry] OTel did not start; Station continues without it:',
              'identity persistence refused',
            );
          } else {
            expect(started).toHaveBeenCalledWith(
              expect.stringContaining('[telemetry] OTel exporting to '),
            );
          }
        });
        await configuredTelemetryShutdownTask()?.shutdown(
          new AbortController().signal,
        );
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        warn.mockRestore();
        started.mockRestore();
      }
    },
  );

  test('refuses an incompatible home before identity writes or provider creation', async () => {
    const root = await createStationTempDir('otel-incompatible');
    homes.push(root);
    await writeFile(join(root, 'unclaimed-history.ndjson'), '{}\n');
    const { initializeTelemetry } = await telemetry();
    const createSdk = vi.fn();
    await expect(
      initializeTelemetry({
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.test' },
        homeDir: root,
        createSdk,
      }),
    ).rejects.toMatchObject({ code: 'STATION_HOME_RESET_REQUIRED' });
    expect(createSdk).not.toHaveBeenCalled();
    expect(await readFile(join(root, 'unclaimed-history.ndjson'), 'utf8')).toBe(
      '{}\n',
    );
    await expect(
      readFile(join(root, 'config', 'otel-installation-id'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test.each(['absent home with writable parent', 'public home'] as const)(
    'automatic telemetry import refuses hosted %s before writes',
    async (scenario) => {
      const parent = await createStationTempDir('otel-hosted-boundary');
      homes.push(parent);
      const root = scenario === 'public home' ? parent : join(parent, 'home');
      await chmod(parent, scenario === 'public home' ? 0o755 : 0o777);
      vi.stubEnv('STATION_HOME', root);
      vi.stubEnv('STATION_ROOT', '');
      vi.stubEnv(
        'STATION_HOSTED_TENANT_REGISTRY_FILE',
        '/deployment/registry.json',
      );
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'https://collector.test');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      metrics.disable();
      let telemetryModule: typeof import('../telemetry.js') | undefined;
      try {
        telemetryModule = await import('../telemetry.js');
        const { configuredTelemetryShutdownTask } = telemetryModule;
        await vi.waitFor(() =>
          expect(warn).toHaveBeenCalledWith(
            '[telemetry] OTel did not start; Station continues without it:',
            expect.stringContaining('private Station persistence boundary'),
          ),
        );
        expect(configuredTelemetryShutdownTask()).toBeUndefined();
        for (const path of [
          '.station-home-schema.json',
          'config/otel-installation-id',
        ]) {
          await expect(stat(join(root, path))).rejects.toMatchObject({
            code: 'ENOENT',
          });
        }
        expect((await stat(parent)).mode & 0o777).toBe(
          scenario === 'public home' ? 0o755 : 0o777,
        );
        if (scenario !== 'public home')
          await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await telemetryModule
          ?.configuredTelemetryShutdownTask()
          ?.shutdown(new AbortController().signal);
        warn.mockRestore();
      }
    },
  );

  test('IDENTITY STORAGE DEFECT: a fresh OTel install persists a UUID and emits its hash', async () => {
    const root = await home();
    const { OTEL_INSTALLATION_ID_ATTRIBUTE } = await telemetry();
    const attributes = await sdkAttributes(root);
    const persisted = (
      await readFile(join(root, 'config', 'otel-installation-id'), 'utf8')
    ).trim();
    expect(persisted, 'fresh OTel installation id was not a UUID').toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(
      attributes[OTEL_INSTALLATION_ID_ATTRIBUTE],
      'OTel emitted an id other than the hash of the persisted UUID',
    ).toBe(createHash('sha256').update(persisted).digest('hex'));
  });

  test('IDENTITY REPAIR DEFECT: malformed OTel installation id is replaced before it is hashed', async () => {
    const root = await home();
    const { OTEL_INSTALLATION_ID_ATTRIBUTE } = await telemetry();
    await mkdir(join(root, 'config'));
    await writeFile(join(root, 'config', 'otel-installation-id'), 'partial');
    const attributes = await sdkAttributes(root);
    const persisted = (
      await readFile(join(root, 'config', 'otel-installation-id'), 'utf8')
    ).trim();
    expect(persisted, 'malformed OTel installation id was accepted').toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(
      attributes[OTEL_INSTALLATION_ID_ATTRIBUTE],
      'OTel hashed malformed installation id content',
    ).toBe(createHash('sha256').update(persisted).digest('hex'));
  });

  test('IDENTITY AUTHORITY DEFECT: OTel emits the hash of the persisted winner', async () => {
    const root = await home();
    const { OTEL_INSTALLATION_ID_ATTRIBUTE } = await telemetry();
    const winner = '11111111-2222-4333-8444-555555555555';
    await mkdir(join(root, 'config'));
    await writeFile(join(root, 'config', 'otel-installation-id'), 'partial');
    renameHook.afterRename = async () => {
      await writeFile(
        join(root, 'config', 'otel-installation-id'),
        `${winner}\n`,
      );
    };
    const attributes = await sdkAttributes(root);
    expect(
      attributes[OTEL_INSTALLATION_ID_ATTRIBUTE],
      'OTel emitted a hash other than the persisted installation id winner',
    ).toBe(createHash('sha256').update(winner).digest('hex'));
  });

  test('INERT OTEL DEFECT: no endpoint performs no identity read or write', async () => {
    const fresh = await home();
    const existing = await home();
    const existingId = join(existing, 'config', 'otel-installation-id');
    await mkdir(join(existing, 'config'));
    await writeFile(existingId, '11111111-2222-4333-8444-555555555555\n');
    const { initializeTelemetry } = await telemetry();
    await initializeTelemetry({ env: {}, homeDir: fresh });
    await initializeTelemetry({ env: {}, homeDir: existing });
    expect(
      readPaths,
      'unconfigured OTel read an existing installation identity',
    ).not.toContain(existingId);
    await expect(
      readFile(join(fresh, 'config', 'otel-installation-id'), 'utf8'),
      'unconfigured OTel wrote an installation identity file',
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  /**
   * Pins the property no machine-derived implementation can have:
   * the id reaching the SDK is a function of the PERSISTED FILE. Two different
   * STATION_HOMEs must produce different ids, and the id must equal the hash of
   * the UUID actually stored in that home.
   */
  test('IDENTITY WIRING DEFECT: the id reaching the SDK is the persisted install id, not the machine', async () => {
    const first = await home();
    const second = await home();
    const { OTEL_INSTALLATION_ID_ATTRIBUTE, initializeTelemetry } =
      await telemetry();
    const pendingCaptured: Record<string, string | Promise<string>>[] = [];
    const createSdk = (
      resourceAttributes: Record<string, string | Promise<string>>,
    ) => {
      pendingCaptured.push({ ...resourceAttributes });
      return { start: () => {}, shutdown: async () => {} };
    };
    const run = (homeDir: string) =>
      initializeTelemetry({
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.test' },
        homeDir,
        createSdk,
        log: () => {},
      });

    await run(first);
    await run(second);
    await run(first);
    const captured = await Promise.all(
      pendingCaptured.map(async (attributes) =>
        Object.fromEntries(
          await Promise.all(
            Object.entries(attributes).map(async ([key, value]) => [
              key,
              await value,
            ]),
          ),
        ),
      ),
    );

    expect(
      captured.length,
      'initializeTelemetry did not reach the SDK factory — the seam this test drives has moved',
    ).toBe(3);
    expect(
      Object.keys(captured[0]).sort(),
      'the SDK received attributes beyond the two this module intends — a machine-derived value can be ADDED alongside a correct installation id, which the id assertions below cannot see',
    ).toEqual([OTEL_INSTALLATION_ID_ATTRIBUTE, 'os.type'].sort());
    expect(
      Object.keys(captured[0]),
      'the retired user.anonymous_id attribute is being emitted again',
    ).not.toContain('user.anonymous_id');

    expect(
      captured[1][OTEL_INSTALLATION_ID_ATTRIBUTE],
      'two separate STATION_HOMEs produced the same id — the id is derived from the machine, not from the persisted install identity',
    ).not.toBe(captured[0][OTEL_INSTALLATION_ID_ATTRIBUTE]);
    expect(
      captured[2][OTEL_INSTALLATION_ID_ATTRIBUTE],
      'the same STATION_HOME produced a different id on a later run — the persisted identity is not being reused',
    ).toBe(captured[0][OTEL_INSTALLATION_ID_ATTRIBUTE]);

    const persisted = (
      await readFile(join(first, 'config', 'otel-installation-id'), 'utf8')
    ).trim();
    expect(
      captured[0][OTEL_INSTALLATION_ID_ATTRIBUTE],
      'the id reaching the SDK is not the hash of the UUID stored in this STATION_HOME',
      // Full digest, deliberately not truncated: the old implementation cut to
      // 48 bits, which only added collisions over a guessable input space.
    ).toBe(createHash('sha256').update(persisted).digest('hex'));
  });

  test('configured OTel is inventoried for shutdown while an inert install is not', async () => {
    const root = await home();
    const { configuredTelemetryShutdownTask, initializeTelemetry } =
      await telemetry();
    expect(configuredTelemetryShutdownTask()).toBeUndefined();
    const shutdown = vi.fn(async () => {});
    await initializeTelemetry({
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.test' },
      homeDir: root,
      createSdk: () => ({ start: () => {}, shutdown }),
      log: () => {},
    });
    const task = configuredTelemetryShutdownTask();
    expect(task?.name).toBe('OTLP telemetry');
    await task?.shutdown(new AbortController().signal);
    expect(shutdown).toHaveBeenCalledOnce();
    expect(configuredTelemetryShutdownTask()).toBeUndefined();
  });

  test('shutdown owns the configured SDK while identity is pending and cannot announce export after stopping', async () => {
    const root = await home();
    const { initializeTelemetry, configuredTelemetryShutdownTask } =
      await telemetry();
    let releaseIdentity = () => {};
    const delayed = new Promise<void>((resolve) => {
      releaseIdentity = resolve;
    });
    identityDelay.beforeMkdir = () => delayed;
    const shutdown = vi.fn(async () => {});
    const log = vi.fn();
    const initializing = initializeTelemetry({
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.test' },
      homeDir: root,
      createSdk: () => ({ start: () => {}, shutdown }),
      log,
    });
    try {
      const task = configuredTelemetryShutdownTask();
      expect(task).toBeDefined();
      const controller = new AbortController();
      controller.abort();
      await task?.shutdown(controller.signal);
      await task?.shutdown(controller.signal);
      expect(shutdown).toHaveBeenCalledOnce();
    } finally {
      releaseIdentity();
      await initializing;
    }
    expect(log).not.toHaveBeenCalled();
  });
});
