import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { createStationTempDir } from '@kontourai/station-shared/temp-dir';
import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { expect, test, vi } from 'vitest';

test('exported HTTP client and server spans omit private scheduler job names and query values', async () => {
  const homeDir = await createStationTempDir('scheduler-trace');
  const bodies: string[] = [];
  const collector = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.url === '/v1/traces') {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  const receiver = http.createServer((_request, response) => response.end());
  try {
    await Promise.all(
      [collector, receiver].map((server) =>
        once(server.listen(0, '127.0.0.1'), 'listening'),
      ),
    );
    const collectorAddress = collector.address();
    const receiverAddress = receiver.address();
    if (
      !collectorAddress ||
      typeof collectorAddress === 'string' ||
      !receiverAddress ||
      typeof receiverAddress === 'string'
    ) {
      throw new Error('loopback servers did not bind TCP');
    }
    const endpoint = `http://127.0.0.1:${collectorAddress.port}`;
    vi.stubEnv('STATION_HOME', homeDir);
    vi.stubEnv('STATION_ROOT', '');
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
    vi.stubEnv('OTEL_NODE_RESOURCE_DETECTORS', 'none');
    vi.stubEnv('OTEL_TRACES_SAMPLER', 'always_on');
    vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'http/dup');
    const telemetry = await import('../telemetry.js');
    const shutdown = new AbortController();
    try {
      await telemetry.initializeTelemetry({
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint },
        homeDir,
        appConfig: {},
        log: () => {},
      });
      const { request: sendRequest }: typeof import('node:http') =
        createRequire(import.meta.url)('http');
      for (const path of [
        '/scheduler/jobs/private%20job/run?name=private-query',
        '/unrelated/control',
      ]) {
        await new Promise<void>((resolve, reject) => {
          const request = sendRequest(
            {
              hostname: '127.0.0.1',
              port: receiverAddress.port,
              path,
              method: 'POST',
            },
            (response) => {
              response.once('error', reject);
              response.once('end', resolve);
              response.resume();
            },
          );
          request.once('error', reject);
          request.end();
        });
      }
      const task = telemetry.configuredTelemetryShutdownTask();
      if (!task)
        throw new Error('configured SDK did not register a shutdown task');
      await task.shutdown(shutdown.signal);
    } finally {
      shutdown.abort();
      await telemetry
        .configuredTelemetryShutdownTask()
        ?.shutdown(shutdown.signal);
    }

    const spans = bodies.flatMap((body) => {
      const payload = JSON.parse(body) as {
        resourceSpans: Array<{
          scopeSpans: Array<{ spans: Array<{ name: string; kind: number }> }>;
        }>;
      };
      return payload.resourceSpans.flatMap(({ scopeSpans }) =>
        scopeSpans.flatMap((scope) => scope.spans),
      );
    });
    const schedulerSpans = spans.filter(
      (span) => span.name === 'POST /scheduler/jobs/:target/run',
    );
    expect(
      schedulerSpans.map((span) => span.kind).sort(),
      JSON.stringify(spans.map(({ name, kind }) => ({ name, kind }))),
    ).toEqual([2, 3]);
    expect(spans).toContainEqual(
      expect.objectContaining({ name: 'POST /', kind: 3 }),
    );
    expect(bodies.join('')).not.toMatch(/private(?:%20| )job|private-query/);
  } finally {
    await Promise.all(
      [receiver, collector].map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    context.disable();
    metrics.disable();
    propagation.disable();
    trace.disable();
    vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true });
  }
});
