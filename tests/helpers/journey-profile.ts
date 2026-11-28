import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { cpus, freemem, platform, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { startJourneyHostObservation } from '../../scripts/lib/journey-host-observation.mjs';

const enabled = Boolean(process.env.STATION_JOURNEY_PROFILE_DIR);

async function readBuildProvenance(page: Page, sourceRevision: string) {
  const buildMode = await page.evaluate(() =>
    document.querySelector('script[src*="/@vite/client"]')
      ? 'development'
      : 'unknown',
  );
  const provenancePath = process.env.STATION_JOURNEY_BUILD_PROVENANCE;
  if (!provenancePath) return { buildMode, buildProvenanceSha256: undefined };
  const provenanceBytes = readFileSync(provenancePath);
  const provenance = JSON.parse(provenanceBytes.toString('utf8'));
  if (
    provenance.version !== 1 ||
    provenance.nodeEnv !== 'production' ||
    provenance.mode !== 'production' ||
    provenance.sourceRevision !== sourceRevision ||
    provenance.outDir !== process.env.STATION_BUILD_UI_DIR ||
    buildMode === 'development'
  )
    throw new Error('Invalid production build provenance');
  const response = await page.request.get(new URL(page.url()).origin);
  if (
    !response.ok() ||
    createHash('sha256')
      .update(await response.body())
      .digest('hex') !== provenance.indexSha256
  )
    throw new Error('Profiled UI does not match the production build');
  return {
    buildMode: 'production',
    buildProvenanceSha256: createHash('sha256')
      .update(provenanceBytes)
      .digest('hex'),
  };
}

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
      documentId: String(performance.timeOrigin),
      longTasks: [] as { startTime: number; duration: number }[],
      inputTimingSupported:
        PerformanceObserver.supportedEntryTypes.includes('event'),
      inputEvents: [] as {
        name: string;
        startTime: number;
        duration: number;
        processingStart: number;
        processingEnd: number;
        interactionId: number;
      }[],
    };
    if (!PerformanceObserver.supportedEntryTypes.includes('longtask'))
      throw new Error('Journey profiling requires long-task observation');
    const collectLongTasks = (entries: PerformanceEntry[]) => {
      for (const entry of entries)
        state.longTasks.push({
          startTime: entry.startTime,
          duration: entry.duration,
        });
    };
    const observer = new PerformanceObserver((entries) =>
      collectLongTasks(entries.getEntries()),
    );
    observer.observe({ type: 'longtask', buffered: true });
    Object.defineProperty(state, 'flushLongTasks', {
      value: () => collectLongTasks(observer.takeRecords()),
    });
    const collectInputEvents = (entries: PerformanceEntry[]) => {
      for (const entry of entries) {
        const event = entry as PerformanceEventTiming;
        if (!(event.interactionId > 0)) continue;
        state.inputEvents.push({
          name: event.name,
          startTime: event.startTime,
          duration: event.duration,
          processingStart: event.processingStart,
          processingEnd: event.processingEnd,
          interactionId: event.interactionId,
        });
      }
    };
    const inputObserver = state.inputTimingSupported
      ? new PerformanceObserver((entries) =>
          collectInputEvents(entries.getEntries()),
        )
      : undefined;
    const inputOptions: PerformanceObserverInit & {
      durationThreshold: number;
    } = {
      type: 'event',
      buffered: true,
      durationThreshold: 16,
    };
    inputObserver?.observe(inputOptions);
    Object.defineProperty(state, 'flushInputEvents', {
      value: () => collectInputEvents(inputObserver?.takeRecords() ?? []),
    });
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
    page.evaluate(() => {
      const state = (window as any).__stationJourneyProfile;
      state?.flushLongTasks();
      state?.flushInputEvents();
      return {
        ...state,
        snapshotTimeMs: performance.now(),
        documentId: String(performance.timeOrigin),
      };
    });
  await client.send('Performance.enable');
  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 1000 });
  await client.send('HeapProfiler.startSampling', {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await client.send('Profiler.start');
  const startCounters = await counters();
  const before = await client.send('Performance.getMetrics');
  const start = performance.now();
  const hostObservation = startJourneyHostObservation();
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
      const host = hostObservation.stop();
      const endCounters = await counters();
      const after = await client.send('Performance.getMetrics');
      const cpu = await client.send('Profiler.stop');
      const heap = await client.send('HeapProfiler.stopSampling');
      const phaseStartMs =
        endCounters.documentId === startCounters.documentId
          ? startCounters.snapshotTimeMs
          : 0;
      const observations: { startTime: number; duration: number }[] =
        endCounters.longTasks;
      const longTasks = observations.filter(
        (entry) =>
          entry.startTime >= phaseStartMs &&
          entry.startTime + entry.duration <= endCounters.snapshotTimeMs,
      );
      const inputEvents: {
        name: string;
        startTime: number;
        duration: number;
        processingStart: number;
        processingEnd: number;
        interactionId: number;
      }[] = endCounters.inputEvents.filter(
        (entry: { startTime: number; duration: number }) =>
          entry.startTime >= phaseStartMs &&
          entry.startTime + entry.duration <= endCounters.snapshotTimeMs,
      );
      const inputDurations = inputEvents.map((entry) => entry.duration);
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
          .filter(
            ([key, value]) =>
              key !== 'snapshotTimeMs' && typeof value === 'number',
          )
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
      const { buildMode, buildProvenanceSha256 } = await readBuildProvenance(
        page,
        sourceRevision,
      );
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
        buildMode,
        buildProvenanceSha256,
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
        logicalCpus: cpus().length,
        memoryAtCapture: { freeBytes: freemem(), totalBytes: totalmem() },
        hostObservation: host,
        browser: page.context().browser()?.version(),
        viewport: page.viewportSize(),
        device: await page.evaluate(() => ({
          userAgent: navigator.userAgent,
          devicePixelRatio: window.devicePixelRatio,
          maxTouchPoints: navigator.maxTouchPoints,
        })),
        workload,
        elapsedMs,
        inputTiming: {
          supported: endCounters.inputTimingSupported,
          scope: 'final-document',
          durationThresholdMs: 16,
          observedEventCount: inputEvents.length,
          observedInteractionCount: new Set(
            inputEvents.map((entry) => entry.interactionId),
          ).size,
          worstObservedInteractionMs:
            inputDurations.length > 0 ? Math.max(...inputDurations) : null,
          events: inputEvents,
        },
        responsiveness: {
          scope: 'final-document',
          phaseStartMs,
          phaseEndMs: endCounters.snapshotTimeMs,
          documentChanged: endCounters.documentId !== startCounters.documentId,
          longTaskCount: longTasks.length,
          longestTaskMs: Math.max(
            0,
            ...longTasks.map((entry) => entry.duration),
          ),
          blockingOver50Ms: longTasks.reduce(
            (sum, entry) => sum + Math.max(0, entry.duration - 50),
            0,
          ),
          longTasks,
        },
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
          !url.startsWith(`${new URL(page.url()).origin}/assets/`) ||
          !/\/[-\w.]+\.js$/.test(url)
        )
          continue;
        const name = `${new URL(url).pathname.split('/').at(-1)!}.map`;
        const path = join(mapsDirectory, name);
        if (!existsSync(path)) {
          const builtUi = process.env.STATION_BUILD_UI_DIR;
          if (builtUi) {
            copyFileSync(resolve(root, builtUi, 'assets', name), path);
          } else {
            const response = await page.request.get(`${url}.map`);
            if (
              !response.ok() ||
              !response.headers()['content-type']?.includes('json')
            )
              continue;
            writeFileSync(path, await response.body());
          }
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
