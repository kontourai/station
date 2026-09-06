import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { usageTelemetryOutcomes } from '../../telemetry/metrics.js';
import {
  assertUsageTelemetryInventoryContract,
  renderUsageTelemetryInventory,
  USAGE_TELEMETRY_INVENTORY_REVISION,
} from '../usage-telemetry-inventory.js';
import { UsageTelemetryService } from '../usage-telemetry-service.js';

/**
 * Lets a test observe what the service does BETWEEN its atomic rename and its
 * read-back of the destination. Without this seam nothing can tell "hash the
 * value that actually persisted" apart from "hash the candidate I just wrote",
 * because in the ordinary case they are the same bytes — an injection that
 * returned the candidate passed the whole suite.
 */
const renameHook: { afterRename?: () => Promise<void> } = {};
const readHook: { beforeRead?: (path: string) => Promise<void> } = {};
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    // `node:fs/promises` has no real default export; under Node's CJS/ESM
    // interop a default import receives the namespace itself, which is what
    // `actual` is. (A delta review suggested `actual.default` as the "exact"
    // preservation — it does not typecheck, because the type has no such
    // property.)
    default: actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      await actual.rename(...args);
      await renameHook.afterRename?.();
    },
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      await readHook.beforeRead?.(String(args[0]));
      return actual.readFile(...args);
    }) as typeof actual.readFile,
  };
});

const homes: string[] = [];
afterEach(async () => {
  renameHook.afterRename = undefined;
  readHook.beforeRead = undefined;
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
async function home(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'station-telemetry-'));
  homes.push(value);
  return value;
}
function logger() {
  return { warn: vi.fn() };
}
async function service(
  options: Partial<ConstructorParameters<typeof UsageTelemetryService>[0]> = {},
) {
  const subject = new UsageTelemetryService({
    homeDir: await home(),
    appConfig: {} as any,
    version: '1.2.3',
    logger: logger(),
    ...options,
  });
  // Existing transport tests exercise post-disclosure behavior; receipt-gate
  // tests below deliberately construct a service without this acknowledgement.
  if (options.env?.STATION_TELEMETRY_ENDPOINT)
    await subject.acknowledgeDisclosure();
  return subject;
}

describe('UsageTelemetryService', () => {
  /**
   * #1582 A3: the first-run disclosure says "none is configured here, so
   * nothing is sent" and offers to keep telemetry on or turn it off. Both
   * are claims about THIS host, and before this the API could see neither:
   * the endpoint is read from the environment in the constructor, and the
   * effective enablement folds config over `STATION_TELEMETRY_ENABLED` over
   * the default. A client left to guess either one would be writing a label
   * with nothing behind it.
   */
  describe('the disclosure reports what the UI would otherwise assert', () => {
    test('an unconfigured host reports no endpoint', async () => {
      const subject = new UsageTelemetryService({
        homeDir: await home(),
        appConfig: {} as any,
        version: '1.2.3',
        logger: logger(),
        env: {},
      });
      const disclosure = await subject.disclosure();
      expect(disclosure.endpointConfigured).toBe(false);
      expect(disclosure.telemetryEnabled).toBe(true);
    });

    test('a configured endpoint is reported, blank and whitespace are not', async () => {
      for (const [endpoint, expected] of [
        ['https://ingest.test', true],
        ['', false],
        ['   ', false],
      ] as const) {
        const subject = new UsageTelemetryService({
          homeDir: await home(),
          appConfig: {} as any,
          version: '1.2.3',
          logger: logger(),
          env: { STATION_TELEMETRY_ENDPOINT: endpoint },
        });
        expect(
          (await subject.disclosure()).endpointConfigured,
          `endpoint ${JSON.stringify(endpoint)} reported wrongly`,
        ).toBe(expected);
      }
    });

    test('the reported enablement is the one that gates emission, not the stored field', async () => {
      // The precedence the emitter itself applies: stored config wins, then
      // the environment, then the default. A UI reading `AppConfig` alone
      // would offer to turn OFF a host the environment had already turned
      // off, and name a state that was not the case.
      const cases = [
        [{}, {}, true],
        [{}, { STATION_TELEMETRY_ENABLED: 'false' }, false],
        [{ telemetryEnabled: false }, {}, false],
        [
          { telemetryEnabled: true },
          { STATION_TELEMETRY_ENABLED: 'false' },
          true,
        ],
      ] as const;
      for (const [appConfig, env, expected] of cases) {
        const subject = new UsageTelemetryService({
          homeDir: await home(),
          appConfig: appConfig as any,
          version: '1.2.3',
          logger: logger(),
          env: env as any,
        });
        expect(
          (await subject.disclosure()).telemetryEnabled,
          `config ${JSON.stringify(appConfig)} + env ${JSON.stringify(env)} reported wrongly`,
        ).toBe(expected);
      }
    });
  });

  test('DISCLOSURE GATE DEFECT: configured telemetry does not buffer, timer, or request before acknowledgement', async () => {
    const fetch = vi.fn();
    const setInterval = vi.fn();
    const subject = new UsageTelemetryService({
      homeDir: await home(),
      appConfig: {} as any,
      version: '1.2.3',
      logger: logger(),
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch,
      setInterval: setInterval as any,
    });
    await subject.stationStarted();
    await subject.shutdown();
    expect(
      fetch,
      'telemetry request attempted before disclosure acknowledgement',
    ).not.toHaveBeenCalled();
    expect(
      setInterval,
      'telemetry timer started before disclosure acknowledgement',
    ).not.toHaveBeenCalled();
    expect(
      subject.bufferedCount,
      'telemetry buffered data before disclosure acknowledgement',
    ).toBe(0);
  });
  test('DISCLOSURE RECEIPT DEFECT: acknowledgement persists and permits emission', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const subject = new UsageTelemetryService({
      homeDir: await home(),
      appConfig: {} as any,
      version: '1.2.3',
      logger: logger(),
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch,
      setInterval: vi.fn() as any,
    });
    await subject.acknowledgeDisclosure();
    await subject.stationStarted();
    await subject.shutdown();
    expect(
      fetch,
      'acknowledged disclosure did not permit telemetry emission',
    ).toHaveBeenCalledTimes(1);
  });
  test('DISCLOSURE REVISION DEFECT: an old inventory receipt stops emission until re-acknowledged', async () => {
    const root = await home();
    await mkdir(join(root, 'config'));
    await writeFile(
      join(root, 'config', 'usage-telemetry-disclosure.json'),
      JSON.stringify({
        acknowledgedAt: new Date().toISOString(),
        inventoryRevision: 'old-revision',
      }),
    );
    const fetch = vi.fn();
    const subject = new UsageTelemetryService({
      homeDir: root,
      appConfig: {} as any,
      version: '1.2.3',
      logger: logger(),
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch,
      setInterval: vi.fn() as any,
    });
    await subject.stationStarted();
    expect(
      fetch,
      'stale disclosure receipt permitted telemetry emission',
    ).not.toHaveBeenCalled();
  });
  test('RESTART DISCLOSURE DEFECT: bootstrap receipt load activates an existing valid receipt without an HTTP request', async () => {
    const root = await home();
    await mkdir(join(root, 'config'));
    await writeFile(
      join(root, 'config', 'usage-telemetry-disclosure.json'),
      JSON.stringify({
        acknowledgedAt: new Date().toISOString(),
        inventoryRevision: USAGE_TELEMETRY_INVENTORY_REVISION,
      }),
    );
    const subject = new UsageTelemetryService({
      homeDir: root,
      appConfig: {} as any,
      version: '1.2.3',
      logger: logger(),
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
    });
    expect(
      subject.active,
      'valid receipt unexpectedly active before bootstrap loads it',
    ).toBe(false);
    await subject.loadDisclosureReceipt();
    expect(
      subject.active,
      'bootstrap did not restore telemetry consent from the saved receipt',
    ).toBe(true);
  });
  test.each([
    ['corrupt JSON', '{'],
    [
      'truncated receipt',
      JSON.stringify({ acknowledgedAt: new Date().toISOString() }),
    ],
    ['unknown receipt shape', JSON.stringify({ receipt: 'unknown' })],
  ])(
    'INVALID DISCLOSURE DEFECT: %s leaves the receipt gate closed and logs',
    async (_kind, contents) => {
      const root = await home();
      await mkdir(join(root, 'config'));
      await writeFile(
        join(root, 'config', 'usage-telemetry-disclosure.json'),
        contents,
      );
      const log = logger();
      const subject = new UsageTelemetryService({
        homeDir: root,
        appConfig: {} as any,
        version: '1.2.3',
        logger: log,
        env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      });
      await subject.loadDisclosureReceipt();
      expect(
        subject.active,
        `${_kind} disclosure receipt opened the telemetry gate`,
      ).toBe(false);
      expect(
        log.warn.mock.calls.some(
          ([message]) =>
            message === 'Usage telemetry disclosure receipt is invalid.',
        ),
        `${_kind} disclosure receipt was not logged`,
      ).toBe(true);
    },
  );
  test('OFF SWITCH DEFECT: a saved Settings off decision attempts no request', async () => {
    const fetch = vi.fn();
    const subject = await service({
      appConfig: { telemetryEnabled: false } as any,
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch,
    });
    await subject.stationStarted();
    await subject.shutdown();
    expect(
      fetch,
      'telemetry request attempted while Settings toggle is off',
    ).not.toHaveBeenCalled();
  });
  test('ENV OFF SWITCH DEFECT: STATION_TELEMETRY_ENABLED=off attempts no request', async () => {
    const fetch = vi.fn();
    const subject = await service({
      env: {
        STATION_TELEMETRY_ENABLED: 'off',
        STATION_TELEMETRY_ENDPOINT: 'https://ingest.test',
      },
      fetch,
    });
    await subject.stationStarted();
    await subject.shutdown();
    expect(
      fetch,
      'telemetry request attempted while STATION_TELEMETRY_ENABLED=off',
    ).not.toHaveBeenCalled();
  });
  test('CREDENTIAL BOUNDARY DEFECT: the OTLP key is never sent to product ingestion', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const subject = await service({
      env: {
        STATION_TELEMETRY_ENDPOINT: 'https://ingest.test',
        STATION_TELEMETRY_API_KEY: 'otlp-only-secret',
      },
      fetch,
      setInterval: vi.fn() as any,
    });
    await subject.stationStarted();
    await subject.shutdown();
    expect(
      fetch.mock.calls[0][1].headers,
      'OTLP credential leaked to the product ingestion endpoint',
    ).not.toHaveProperty('x-api-key');
  });
  test('NO ENDPOINT DEFECT: no request, timer, or buffered growth occurs', async () => {
    const fetch = vi.fn();
    const setInterval = vi.fn();
    const subject = await service({ fetch, setInterval: setInterval as any });
    await subject.stationStarted();
    expect(
      fetch,
      'telemetry request attempted without endpoint',
    ).not.toHaveBeenCalled();
    expect(
      setInterval,
      'telemetry timer started without endpoint',
    ).not.toHaveBeenCalled();
    expect(
      subject.bufferedCount,
      'telemetry buffered data without endpoint',
    ).toBe(0);
    await expect(
      access(
        join((subject as any).options.homeDir, 'config', 'usage-telemetry-id'),
      ),
      'telemetry identity was created without an endpoint',
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  test('BUFFER BOUND DEFECT: overflow drops oldest and logs instead of growing', async () => {
    const log = logger();
    const subject = await service({
      logger: log,
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      setInterval: vi.fn() as any,
    });
    for (let index = 0; index < 101; index++) await subject.stationStarted();
    expect(
      subject.bufferedCount,
      'telemetry buffer grew beyond its 100-event bound',
    ).toBe(100);
    expect(
      log.warn,
      'telemetry buffer overflow was not logged',
    ).toHaveBeenCalledWith(
      'Usage telemetry buffer overflow; dropped oldest event.',
    );
    await subject.shutdown();
  });
  test('SHUTDOWN DRAIN DEFECT: waits for accepted background identity persistence', async () => {
    let identityRenameStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      identityRenameStarted = resolve;
    });
    let releaseIdentityRename!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseIdentityRename = resolve;
    });
    const subject = await service({
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch: vi.fn().mockResolvedValue({ ok: true, status: 202 }),
      setInterval: vi.fn() as any,
    });
    await writeFile(
      join((subject as any).options.homeDir, 'config', 'usage-telemetry-id'),
      'partial',
    );
    renameHook.afterRename = async () => {
      identityRenameStarted();
      await release;
    };

    await subject.stationStarted();
    void subject.flush();
    await started;
    let shutdownFinished = false;
    const shutdown = subject.shutdown().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(
      shutdownFinished,
      'shutdown resolved while owned identity persistence was still active',
    ).toBe(false);
    releaseIdentityRename();
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });

  test('SHUTDOWN DRAIN: waits for a tracked operation with no flush in flight', async () => {
    // Discriminates the tracking drain itself: the identity-rename variant
    // above also blocks through the in-flight flush await, so removing the
    // Promise.allSettled([...tracking]) drain survived it (caught by fault
    // injection). Here the ONLY thing holding shutdown is a track() whose
    // disclosure read is held open — no flush() exists to double-cover.
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let releaseRead!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const subject = await service({
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch: vi.fn().mockResolvedValue({ ok: true, status: 202 }),
      setInterval: vi.fn() as any,
    });
    readHook.beforeRead = async (path) => {
      if (path.includes('disclosure')) {
        readStarted();
        await release;
      }
    };
    (subject as any).hasCurrentDisclosureReceipt = false;
    void subject.track('station_started' as any, {} as any);
    await started;
    readHook.beforeRead = undefined;
    let shutdownFinished = false;
    const shutdown = subject.shutdown().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(
      shutdownFinished,
      'shutdown resolved while a tracked operation was still active',
    ).toBe(false);
    releaseRead();
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });
  test('REQUEUE DEFECT: failed batch is retained and retried without throwing', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 202 });
    const subject = await service({
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch,
      setInterval: vi.fn() as any,
    });
    await subject.stationStarted();
    await subject.flush();
    expect(
      subject.bufferedCount,
      'failed telemetry batch was dropped instead of requeued',
    ).toBe(1);
    await expect(
      subject.flush(),
      'permanently failing telemetry endpoint threw into caller',
    ).resolves.toBeUndefined();
    expect(
      fetch,
      'requeued telemetry batch was not retried',
    ).toHaveBeenCalledTimes(2);
  });
  test('SHUTDOWN FLUSH DEFECT: shutdown sends the pending batch', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const subject = await service({
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch,
      setInterval: vi.fn() as any,
    });
    await subject.stationStarted();
    await subject.shutdown();
    expect(
      fetch,
      'shutdown did not flush pending telemetry',
    ).toHaveBeenCalledTimes(1);
  });
  test('SHUTDOWN DRAIN DEFECT: shutdown sends every buffered batch', async () => {
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const fetch = vi
      .fn()
      .mockImplementationOnce(async () => {
        await first;
        return { ok: true, status: 202 };
      })
      .mockResolvedValue({ ok: true, status: 202 });
    const subject = await service({
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch,
      setInterval: vi.fn() as any,
    });
    for (let index = 0; index < 45; index++) await subject.stationStarted();
    releaseFirst!();
    await subject.shutdown();
    expect(
      fetch,
      'shutdown dropped buffered telemetry batches',
    ).toHaveBeenCalledTimes(3);
    expect(
      subject.bufferedCount,
      'shutdown left acknowledged events buffered',
    ).toBe(0);
  });
  test('SHUTDOWN DUPLICATION DEFECT: a healthy in-flight batch is awaited, not aborted and retried', async () => {
    let release: (() => void) | undefined;
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn().mockImplementation(
      (_url, init: RequestInit) =>
        new Promise((resolve) => {
          requestSignal = init.signal ?? undefined;
          release = () => resolve({ ok: true, status: 202 });
        }),
    );
    const add = vi.spyOn(usageTelemetryOutcomes, 'add');
    const subject = await service({
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch,
      setInterval: vi.fn() as any,
    });
    try {
      await subject.stationStarted();
      const flushing = subject.flush();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      const stopping = subject.shutdown();
      expect(
        requestSignal?.aborted,
        'shutdown aborted a healthy in-flight telemetry batch and risks duplication',
      ).toBe(false);
      release!();
      await Promise.all([flushing, stopping]);
      expect(
        fetch,
        'shutdown retried an already accepted telemetry batch and duplicated events',
      ).toHaveBeenCalledTimes(1);
      expect(
        add.mock.calls.some(
          ([, attributes]) => attributes?.outcome === 'batch_failed',
        ),
        'shutdown recorded batch_failed for an acknowledged telemetry batch',
      ).toBe(false);
    } finally {
      add.mockRestore();
    }
  });
  test('SHUTDOWN BOUND DEFECT: a failing endpoint cannot hang shutdown', async () => {
    let requestSignal: AbortSignal | undefined;
    const subject = await service({
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch: vi.fn().mockImplementation((_url, init: RequestInit) => {
        requestSignal = init.signal ?? undefined;
        return new Promise((_, reject) =>
          init.signal?.addEventListener(
            'abort',
            () => reject(new Error('telemetry request aborted')),
            { once: true },
          ),
        );
      }),
      setInterval: vi.fn() as any,
    });
    await subject.stationStarted();
    const startedAt = Date.now();
    await expect(
      Promise.race([
        subject.shutdown(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('telemetry shutdown exceeded its watchdog')),
            1_700,
          ),
        ),
      ]),
      'failed telemetry shutdown did not settle before its watchdog',
    ).resolves.toBeUndefined();
    expect(
      Date.now() - startedAt,
      'telemetry shutdown ignored its request deadline and exceeded the watchdog',
    ).toBeLessThan(1_700);
    expect(
      requestSignal?.aborted,
      'telemetry shutdown deadline did not abort the hanging request signal',
    ).toBe(true);
  });
  test('shared shutdown expiry aborts delivery and discards instead of retrying', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn().mockImplementation((_url, init: RequestInit) => {
      requestSignal = init.signal ?? undefined;
      return new Promise((_, reject) =>
        init.signal?.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          {
            once: true,
          },
        ),
      );
    });
    const subject = await service({
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch,
      setInterval: vi.fn() as any,
    });
    await subject.stationStarted();
    const controller = new AbortController();
    const stopping = subject.shutdown(controller.signal);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await Promise.resolve();
    controller.abort();
    await expect(stopping).resolves.toBeUndefined();
    expect(requestSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(subject.bufferedCount).toBe(0);
  });
  test('LIVE DISABLE DEFECT: disabling telemetry aborts and discards an in-flight request', async () => {
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn().mockImplementation(
      (_url, init: RequestInit) =>
        new Promise((_, reject) => {
          requestSignal = init.signal ?? undefined;
          init.signal?.addEventListener(
            'abort',
            () =>
              reject(new Error('telemetry request aborted by live disable')),
            { once: true },
          );
        }),
    );
    const subject = await service({
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch,
      setInterval: vi.fn() as any,
    });
    await subject.stationStarted();
    const flushing = subject.flush();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    subject.reconfigure({ telemetryEnabled: false } as any);
    await flushing;
    await subject.shutdown();
    expect(
      requestSignal?.aborted,
      'live telemetry disable left the in-flight request active after consent withdrawal',
    ).toBe(true);
    expect(
      subject.bufferedCount,
      'live telemetry disable retained an in-flight batch for later delivery',
    ).toBe(0);
    expect(
      fetch,
      'live telemetry disable retried a withdrawn-consent batch',
    ).toHaveBeenCalledTimes(1);
  });
  test('FAIL-OPEN DEFECT: identity storage and synchronous fetch failures do not reject', async () => {
    const root = await home();
    const fileHome = join(root, 'not-a-directory');
    await writeFile(fileHome, 'x');
    const subject = new UsageTelemetryService({
      homeDir: fileHome,
      appConfig: {} as any,
      version: '1.2.3',
      logger: logger(),
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch: (() => {
        throw new Error('synchronous fetch failure');
      }) as any,
      setInterval: vi.fn() as any,
    });
    await subject.stationStarted();
    await expect(
      subject.flush(),
      'telemetry filesystem or synchronous fetch failure escaped to caller',
    ).resolves.toBeUndefined();
  });
  test('LIVE DRIFT DEFECT: undeclared properties are dropped without rejecting the caller', async () => {
    const fetch = vi.fn();
    const log = logger();
    const subject = await service({
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch,
      logger: log,
      setInterval: vi.fn() as any,
    });
    await expect(
      subject.track('station_started', {
        version: '1.2.3',
        platform: 'linux',
        arch: 'x64',
        undeclared: 'x',
      } as any),
      'inventory drift escaped the telemetry emitter boundary',
    ).resolves.toBeUndefined();
    expect(
      fetch,
      'inventory-drift event reached the endpoint',
    ).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Usage telemetry event dropped.',
      expect.objectContaining({
        error:
          'Usage telemetry inventory drift: property "station_started.undeclared" is not published.',
      }),
    );
  });
  test('OUTCOME CLASSIFICATION DEFECT: non-inventory failures are not reported as drift', async () => {
    const subject = await service({
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      setInterval: (() => {
        throw new Error('timer failure');
      }) as any,
    });
    const recordOutcome = vi.fn();
    (subject as any).recordOutcome = recordOutcome;
    await subject.stationStarted();
    expect(
      recordOutcome,
      'non-inventory telemetry failure was reported as inventory drift',
    ).toHaveBeenCalledWith('event_rejected');
    expect(recordOutcome).not.toHaveBeenCalledWith('drift_rejected');
  });
  test('IDENTITY DEFECT: persisted random id is stable, and only its hash is sent', async () => {
    const root = await home();
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const opts = {
      homeDir: root,
      appConfig: {} as any,
      version: '1.2.3',
      logger: logger(),
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch,
      setInterval: vi.fn() as any,
    };
    const first = new UsageTelemetryService(opts);
    await first.acknowledgeDisclosure();
    await first.stationStarted();
    await first.shutdown();
    const raw = (
      await readFile(join(root, 'config', 'usage-telemetry-id'), 'utf8')
    ).trim();
    const second = new UsageTelemetryService(opts);
    await second.stationStarted();
    await second.shutdown();
    const bodies = fetch.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(raw, 'telemetry identity was not a UUID').toMatch(
      /^[0-9a-f-]{36}$/i,
    );
    expect(
      bodies[0].distinct_id,
      'raw telemetry identity left the process',
    ).not.toBe(raw);
    expect(
      bodies[0].distinct_id,
      'telemetry identity changed across restart',
    ).toBe(bodies[1].distinct_id);
    expect(
      bodies[0].distinct_id,
      'telemetry identity is not a SHA-256 hash',
    ).toMatch(/^[0-9a-f]{64}$/);
  });
  test('INVENTORY DRIFT DEFECT: unpublished code property names the defect', () => {
    expect(() =>
      assertUsageTelemetryInventoryContract('station_started', {
        version: '1.2.3',
        platform: 'linux',
        arch: 'x64',
        prompt: 'bad',
      }),
    ).toThrow(
      'Usage telemetry inventory drift: property "station_started.prompt" is not published.',
    );
  });
  test('INVENTORY DRIFT DEFECT: missing published property names the defect', () => {
    expect(() =>
      assertUsageTelemetryInventoryContract('station_started', {
        version: '1.2.3',
        platform: 'linux',
      }),
    ).toThrow(
      'Usage telemetry inventory drift: published property "station_started.arch" is missing from code.',
    );
  });
  test('VALUE DOMAIN DEFECT: free text version is rejected and names the property', () => {
    expect(() =>
      assertUsageTelemetryInventoryContract('station_started', {
        version: 'my-private-repository',
        platform: 'linux',
        arch: 'x64',
      }),
    ).toThrow(
      'Usage telemetry inventory drift: property "station_started.version" has invalid value "my-private-repository"; permitted: SemVer version (MAJOR.MINOR.PATCH, with optional prerelease/build metadata).',
    );
  });
  test.each([
    [
      'session recovery',
      'session_recovery',
      { failure_kind: 'capacity', decision: 'retry-now', outcome: 'succeeded' },
      {
        failure_kind: 'private error text',
        decision: 'retry-now',
        outcome: 'succeeded',
      },
      'Usage telemetry inventory drift: property "session_recovery.failure_kind" has invalid value "private error text"; permitted: authentication, capacity, rate-limit, unknown.',
    ],
    [
      'engine turn',
      'engine_turn',
      { engine: 'codex', outcome: 'completed' },
      { engine: 'vendor-moving-model-id', outcome: 'completed' },
      'Usage telemetry inventory drift: property "engine_turn.engine" has invalid value "vendor-moving-model-id"; permitted: station, acp, bedrock, claude, codex, muse, ollama, other.',
    ],
  ])(
    'VALUE DOMAIN DEFECT: %s rejects an out-of-domain property',
    (_label, event, valid, invalid, failureText) => {
      expect(() =>
        assertUsageTelemetryInventoryContract(
          event,
          valid as Record<string, unknown>,
        ),
      ).not.toThrow();
      expect(() =>
        assertUsageTelemetryInventoryContract(
          event,
          invalid as Record<string, unknown>,
        ),
      ).toThrow(failureText);
    },
  );
  test('INERT CALL-SITE DEFECT: new telemetry methods do not buffer, time, or send without an endpoint', async () => {
    const fetch = vi.fn();
    const setInterval = vi.fn();
    const subject = await service({ fetch, setInterval: setInterval as any });
    subject.trackSessionRecovery({
      failure_kind: 'capacity',
      decision: 'retry-now',
      outcome: 'armed',
    });
    subject.trackEngineTurn({ engine: 'codex', outcome: 'completed' });
    await Promise.resolve();
    expect(
      fetch,
      'new telemetry call site sent without an endpoint',
    ).not.toHaveBeenCalled();
    expect(
      setInterval,
      'new telemetry call site timed without an endpoint',
    ).not.toHaveBeenCalled();
    expect(
      subject.bufferedCount,
      'new telemetry call site buffered without an endpoint',
    ).toBe(0);
  });
  test('ACKNOWLEDGEMENT DEFECT: overflow during a slow batch retains newer unsent events', async () => {
    let release: (() => void) | undefined;
    const fetch = vi.fn().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, status: 202 });
        }),
    );
    const subject = await service({
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch,
      setInterval: vi.fn() as any,
    });
    for (let index = 0; index < 110; index++)
      await subject.track('station_started', {
        version: `1.0.${index}`,
        platform: 'linux',
        arch: 'x64',
      });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    release!();
    await (subject as any).flushing;
    expect(
      subject.bufferedCount,
      'successful acknowledgement dropped newer unsent telemetry events',
    ).toBe(90);
  });
  test('IDENTITY RACE DEFECT: concurrent creation converges on one UUID', async () => {
    const root = await home();
    await mkdir(join(root, 'config'));
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const options = {
      homeDir: root,
      appConfig: {} as any,
      version: '1.2.3',
      logger: logger(),
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch,
      setInterval: vi.fn() as any,
    };
    const [one, two] = [
      new UsageTelemetryService(options),
      new UsageTelemetryService(options),
    ];
    await Promise.all([one.stationStarted(), two.stationStarted()]);
    await Promise.all([one.shutdown(), two.shutdown()]);
    const ids = fetch.mock.calls.map(
      (call) => JSON.parse(call[1].body).distinct_id,
    );
    expect(
      ids[0],
      'concurrent telemetry identity creation split identities',
    ).toBe(ids[1]);
  });
  test('IDENTITY VALIDATION DEFECT: malformed identity is replaced before hashing', async () => {
    const root = await home();
    await mkdir(join(root, 'config'));
    await writeFile(join(root, 'config', 'usage-telemetry-id'), 'partial');
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const subject = new UsageTelemetryService({
      homeDir: root,
      appConfig: {} as any,
      version: '1.2.3',
      logger: logger(),
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch,
      setInterval: vi.fn() as any,
    });
    await subject.acknowledgeDisclosure();
    await subject.stationStarted();
    await subject.shutdown();
    expect(
      (
        await readFile(join(root, 'config', 'usage-telemetry-id'), 'utf8')
      ).trim(),
      'malformed telemetry identity was accepted',
    ).toMatch(/^[0-9a-f-]{36}$/i);
  });
  test('IDENTITY REPAIR RACE DEFECT: concurrent repair never sends an unpersisted or malformed value', async () => {
    // archive#2238 posture: no hand-rolled filesystem lock for an anonymous
    // analytics id. So concurrent repair of a corrupted file may leave the two
    // processes on different pseudonyms for their own run — disclosed and
    // accepted. What must ALWAYS hold is that nobody hashes the malformed
    // content, nobody hashes a candidate it did not read back from the
    // destination, and the file converges to exactly one valid UUID.
    const root = await home();
    await mkdir(join(root, 'config'));
    await writeFile(join(root, 'config', 'usage-telemetry-id'), 'partial');
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const options = {
      homeDir: root,
      appConfig: {} as any,
      version: '1.2.3',
      logger: logger(),
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch,
      setInterval: vi.fn() as any,
    };
    const [one, two] = [
      new UsageTelemetryService(options),
      new UsageTelemetryService(options),
    ];
    await one.acknowledgeDisclosure();
    await Promise.all([one.stationStarted(), two.stationStarted()]);
    await Promise.all([one.shutdown(), two.shutdown()]);
    const persisted = (
      await readFile(join(root, 'config', 'usage-telemetry-id'), 'utf8')
    ).trim();
    const sentIds = fetch.mock.calls.map(
      (call) => JSON.parse(call[1].body).distinct_id,
    );
    expect(
      persisted,
      'concurrent identity repair did not converge on one valid UUID',
    ).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(
      sentIds,
      'malformed identity content was hashed and sent',
    ).not.toContain(createHash('sha256').update('partial').digest('hex'));
    for (const sent of sentIds)
      expect(sent, 'telemetry identity was not a SHA-256 hash').toMatch(
        /^[0-9a-f]{64}$/,
      );
    expect(
      new Set(sentIds).size,
      'concurrent repair produced more identities than there were processes',
    ).toBeLessThanOrEqual(2);
  });
  test("IDENTITY AUTHORITY DEFECT: the persisted winner is hashed, not this process's own candidate", async () => {
    // A competing process replaces the file between our rename and our
    // read-back. Correct behaviour hashes what is actually persisted; hashing
    // our own candidate detaches this run from the stored identity forever.
    const root = await home();
    await mkdir(join(root, 'config'));
    await writeFile(join(root, 'config', 'usage-telemetry-id'), 'partial');
    const winner = '11111111-2222-4333-8444-555555555555';
    renameHook.afterRename = async () => {
      await writeFile(
        join(root, 'config', 'usage-telemetry-id'),
        `${winner}\n`,
      );
    };
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    const subject = await service({
      homeDir: root,
      env: { STATION_TELEMETRY_ENDPOINT: 'https://ingest.test' },
      fetch,
      setInterval: vi.fn() as any,
    });
    await subject.stationStarted();
    await subject.shutdown();
    const sent = JSON.parse(fetch.mock.calls[0][1].body).distinct_id;
    expect(
      sent,
      'telemetry hashed its own candidate instead of the identity that persisted',
    ).toBe(createHash('sha256').update(winner).digest('hex'));
  });
  test('DOCUMENT INVENTORY DEFECT: published docs are rendered from the registry', async () => {
    const docs = await readFile(
      join(process.cwd(), 'docs/reference/usage-telemetry.md'),
      'utf8',
    );
    expect(
      docs,
      'published telemetry inventory drifted from registry',
    ).toContain(renderUsageTelemetryInventory());
  });
});
