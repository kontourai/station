import { rm } from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import { createStationTempDir } from '@kontourai/station-shared/temp-dir';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import type { NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import { afterEach, expect, test, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  options: undefined as Partial<NodeSDKConfiguration> | undefined,
}));
let homeDir: string | undefined;
vi.mock('@opentelemetry/sdk-node', async (original) => {
  const actual = await original<typeof import('@opentelemetry/sdk-node')>();
  return {
    ...actual,
    NodeSDK: class {
      constructor(options: Partial<NodeSDKConfiguration>) {
        captured.options = options;
      }
      start() {}
      async shutdown() {}
    },
  };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  captured.options = undefined;
  if (homeDir) await rm(homeDir, { recursive: true, force: true });
  homeDir = undefined;
});

test('the installed HTTP span hook removes automation job names from trace fields', async () => {
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
  homeDir = await createStationTempDir('scheduler-trace');
  const telemetry = await import('../telemetry.js');
  await telemetry.initializeTelemetry({
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:12345' },
    homeDir,
    appConfig: {},
    log: () => {},
  });
  const require = createRequire(import.meta.url);
  const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } =
    require('@opentelemetry/sdk-trace-base') as typeof import('@opentelemetry/sdk-trace-base');
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const privatePath = '/scheduler/jobs/private%20job/run?name=private-job';
  const instrumentation = captured.options?.instrumentations
    ?.flat()
    .find(
      (item): item is HttpInstrumentation =>
        item instanceof HttpInstrumentation,
    );
  const hook = instrumentation?.getConfig().requestHook;
  if (!hook) throw new Error('HTTP instrumentation has no request hook');
  for (const request of [
    { method: 'POST', url: privatePath } as IncomingMessage,
    { method: 'POST', path: privatePath } as ClientRequest,
  ]) {
    const span = provider.getTracer('test').startSpan('POST');
    span.setAttributes({
      'url.path': '/scheduler/jobs/private%20job/run',
      'url.query': 'name=private-job',
      'url.full': `http://station.test${privatePath}`,
      'http.target': privatePath,
      'http.url': `http://station.test${privatePath}`,
    });
    hook(span, request);
    span.end();
  }
  expect(exporter.getFinishedSpans()).toHaveLength(2);
  for (const span of exporter.getFinishedSpans()) {
    expect(span.name).toBe('POST /scheduler/jobs/:target/run');
    expect(JSON.stringify(span.attributes)).not.toContain('private');
  }
  const unrelated = provider.getTracer('test').startSpan('POST');
  hook(unrelated, {
    method: 'POST',
    path: '/unrelated/private',
  } as ClientRequest);
  unrelated.end();
  expect(exporter.getFinishedSpans()[2].name).toBe('POST /');
  await provider.shutdown();
  await telemetry
    .configuredTelemetryShutdownTask()
    ?.shutdown(new AbortController().signal);
});
