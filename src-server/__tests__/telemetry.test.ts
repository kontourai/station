import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const sdkModule = vi.hoisted(() => ({
  loads: 0,
  start: vi.fn(),
  shutdown: vi.fn(async () => {}),
}));

vi.mock('@opentelemetry/sdk-node', () => {
  sdkModule.loads++;
  return {
    NodeSDK: class {
      start = sdkModule.start;
      shutdown = sdkModule.shutdown;
    },
  };
});

const homes: string[] = [];
const renameHook: { afterRename?: () => Promise<void> } = {};
const readPaths: string[] = [];

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
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
  sdkModule.start.mockClear();
  sdkModule.shutdown.mockClear();
  renameHook.afterRename = undefined;
  readPaths.length = 0;
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

async function home(): Promise<string> {
  const value = await mkdtemp(join(os.tmpdir(), 'station-otel-'));
  homes.push(value);
  return value;
}

async function telemetry() {
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
  return import('../telemetry.js');
}

/** Starts configured OTel for one home and returns what reached the SDK. */
async function sdkAttributes(homeDir: string) {
  const { initializeTelemetry } = await telemetry();
  let captured: Record<string, string> | undefined;
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
  return captured;
}

describe('OTel installation identity', () => {
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
    expect(sdkModule.loads, 'unconfigured OTel loaded its SDK').toBe(0);
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
    const captured: Record<string, string>[] = [];
    const createSdk = (resourceAttributes: Record<string, string>) => {
      captured.push({ ...resourceAttributes });
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

  test('loads and starts the SDK only for a configured endpoint, then shuts it down', async () => {
    const root = await home();
    const { initializeTelemetry, configuredTelemetryShutdownTask } =
      await telemetry();
    expect(sdkModule.loads).toBe(0);
    await initializeTelemetry({
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.test' },
      homeDir: root,
      log: () => {},
    });
    expect(sdkModule.loads).toBe(1);
    expect(sdkModule.start).toHaveBeenCalledOnce();
    await configuredTelemetryShutdownTask()?.shutdown(
      new AbortController().signal,
    );
    expect(sdkModule.shutdown).toHaveBeenCalledOnce();
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
});
