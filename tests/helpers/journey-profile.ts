import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';

const enabled = Boolean(process.env.STATION_JOURNEY_PROFILE_DIR);

/** Installed before React loads. Profiling is opt-in and changes no product code. */
export async function installJourneyProfile(page: Page): Promise<void> {
  if (!enabled) return;
  await page.addInitScript(() => {
    const state = {
      commits: 0,
      unmounts: 0,
      domMutations: 0,
      storageReads: 0,
      storageWrites: 0,
      storageMs: 0,
      readsByKey: {} as Record<string, number>,
    };
    (window as any).__stationJourneyProfile = state;
    const existing = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (existing)
      throw new Error(
        'Journey profiling needs a browser without another DevTools hook',
      );
    (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject(renderer: unknown) {
        this.renderers.set(1, renderer);
        return 1;
      },
      onCommitFiberRoot() {
        state.commits++;
      },
      onCommitFiberUnmount() {
        state.unmounts++;
      },
      onPostCommitFiberRoot() {},
    };
    for (const method of ['getItem', 'setItem'] as const) {
      const original = Storage.prototype[method];
      Object.defineProperty(Storage.prototype, method, {
        configurable: true,
        writable: true,
        value: function (...args: string[]) {
          const start = performance.now();
          if (method === 'getItem') {
            state.storageReads++;
            const key = args[0].slice(0, 120);
            state.readsByKey[key] = (state.readsByKey[key] ?? 0) + 1;
          } else state.storageWrites++;
          try {
            return Reflect.apply(original, this, args);
          } finally {
            state.storageMs += performance.now() - start;
          }
        },
      });
    }
    new MutationObserver((records) => {
      state.domMutations += records.length;
    }).observe(document, {
      childList: true,
      attributes: true,
      characterData: true,
      subtree: true,
    });
  });
}

/** Retains raw CPU/allocation profiles plus diagnostic counters; no uncalibrated timing gate. */
export async function profileJourney(
  page: Page,
  info: TestInfo,
  id: string,
  workload: Record<string, number>,
  action: () => Promise<void>,
): Promise<void> {
  if (!enabled) return action();
  const root = process.cwd();
  const directory = process.env.STATION_JOURNEY_PROFILE_DIR!;
  mkdirSync(directory, { recursive: true });
  const client = await page.context().newCDPSession(page);
  const counters = async () =>
    page.evaluate(() => ({ ...(window as any).__stationJourneyProfile }));
  const startCounters = await counters();
  await client.send('Performance.enable');
  const before = await client.send('Performance.getMetrics');
  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 1000 });
  await client.send('HeapProfiler.startSampling', {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await client.send('Profiler.start');
  const start = performance.now();
  let passed = false;
  let observed = false;
  try {
    await action();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    passed = true;
  } finally {
    try {
      const elapsedMs = performance.now() - start;
      const cpu = await client.send('Profiler.stop');
      const heap = await client.send('HeapProfiler.stopSampling');
      const after = await client.send('Performance.getMetrics');
      const endCounters = await counters();
      const metricBefore = Object.fromEntries(
        before.metrics.map((metric) => [metric.name, metric.value]),
      );
      const metrics = Object.fromEntries(
        after.metrics
          .filter((metric) =>
            [
              'TaskDuration',
              'ScriptDuration',
              'LayoutDuration',
              'RecalcStyleDuration',
            ].includes(metric.name),
          )
          .map((metric) => [
            metric.name,
            (metric.value - (metricBefore[metric.name] ?? 0)) * 1000,
          ]),
      );
      const deltas = Object.fromEntries(
        Object.entries(endCounters)
          .filter(([, value]) => typeof value === 'number')
          .map(([key, value]) => [
            key,
            Number(value) - Number(startCounters[key] ?? 0),
          ]),
      );
      const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
      observed =
        Number.isFinite(deltas.commits) &&
        deltas.commits > 0 &&
        (cpu.profile.samples?.length ?? 0) > 0;
      const profile = {
        version: 1,
        id,
        outcome: passed && observed ? 'passed' : 'failed',
        sourceRevision,
        dirty: Boolean(
          execFileSync('git', ['status', '--porcelain'], {
            cwd: root,
            encoding: 'utf8',
            windowsHide: true,
          }).trim(),
        ),
        buildMode: await page.evaluate(() =>
          document.querySelector('script[src*="/@vite/client"]')
            ? 'development'
            : 'production',
        ),
        storageReadsByKey: Object.fromEntries(
          Object.entries(endCounters.readsByKey ?? {})
            .map(([key, value]) => [
              key,
              Number(value) - Number(startCounters.readsByKey?.[key] ?? 0),
            ])
            .filter(([, value]) => Number(value) > 0),
        ),
        platform: platform(),
        osRelease: release(),
        cpu: cpus()[0]?.model,
        browser: page.context().browser()?.version(),
        workload,
        elapsedMs,
        metricsMs: metrics,
        counters: deltas,
        sampledAllocationBytes: heap.profile.samples.reduce(
          (sum, sample) => sum + sample.size,
          0,
        ),
        cpuSamples: cpu.profile.samples?.length ?? 0,
        heapUsedBytes: after.metrics.find(
          (metric) => metric.name === 'JSHeapUsedSize',
        )?.value,
        files: { cpu: `${id}.cpuprofile`, allocations: `${id}.heapprofile` },
      };
      writeFileSync(
        join(directory, `${id}.cpuprofile`),
        JSON.stringify(cpu.profile),
      );
      writeFileSync(
        join(directory, `${id}.heapprofile`),
        JSON.stringify(heap.profile),
      );
      const mapsDirectory = join(directory, 'maps');
      mkdirSync(mapsDirectory, { recursive: true });
      const sourceMaps: string[] = [];
      for (const url of new Set(
        cpu.profile.nodes.map((node) => node.callFrame.url),
      )) {
        if (
          !url.startsWith(new URL(page.url()).origin + '/assets/') ||
          !/\/[-\w.]+\.js$/.test(url)
        )
          continue;
        const name = new URL(url).pathname.split('/').at(-1)! + '.map';
        const path = join(mapsDirectory, name);
        if (!existsSync(path)) {
          const response = await page.request.get(url + '.map');
          if (
            !response.ok() ||
            !response.headers()['content-type']?.includes('json')
          )
            continue;
          writeFileSync(path, await response.body());
        }
        sourceMaps.push(`maps/${name}`);
      }
      Object.assign(profile, { sourceMaps });
      const output = join(directory, `${id}.json`);
      writeFileSync(output, JSON.stringify(profile, null, 2));
      await info.attach(id, { path: output, contentType: 'application/json' });
    } finally {
      await client.detach();
    }
  }
  if (!observed)
    throw new Error('Profile instrumentation did not observe the journey');
}
