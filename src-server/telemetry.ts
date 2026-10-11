/**
 * Register configured providers synchronously; exporters wait for the persisted
 * installation identity without holding up Station startup.
 */

import { platform } from 'node:os';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import {
  defaultResource,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import {
  AggregationTemporality,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { core, NodeSDK } from '@opentelemetry/sdk-node';
import { ensureStationHomeSchemaSync } from './domain/home-schema-gate.js';
import { assertHostedPersistenceBeforeSchemaSync } from './runtime/bootstrap/hosted-persistence-boundary.js';
import { persistedRandomIdentifierHash } from './services/persisted-random-identifier.js';
import { resolveHomeDir } from './utils/paths.js';

export const OTEL_INSTALLATION_ID_ATTRIBUTE = 'service.installation.id';

type TelemetrySdk = Pick<NodeSDK, 'start' | 'shutdown'>;
type TelemetryResourceAttributes = Record<string, string | Promise<string>>;
const activeTelemetrySdks = new Set<Pick<TelemetrySdk, 'shutdown'>>();
export interface InitializeTelemetryOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  createSdk?: (
    resourceAttributes: TelemetryResourceAttributes,
    endpoint: string,
  ) => TelemetrySdk;
  log?: (message: string) => void;
}

function createSdk(
  resourceAttributes: TelemetryResourceAttributes,
  endpoint: string,
): NodeSDK {
  const telemetryApiKey = process.env.STATION_TELEMETRY_API_KEY;
  const headers = telemetryApiKey
    ? { 'x-api-key': telemetryApiKey }
    : undefined;
  const identity = Promise.resolve(
    resourceAttributes[OTEL_INSTALLATION_ID_ATTRIBUTE],
  );
  const traceExporter = new OTLPTraceExporter({
    url: `${endpoint}/v1/traces`,
    headers,
  });
  const metricExporter = new OTLPMetricExporter({
    url: `${endpoint}/v1/metrics`,
    headers,
    temporalityPreference: AggregationTemporality.DELTA,
  });
  // Resource rejection omits an attribute in OTel. Never export an unidentified
  // payload when Station could not persist its installation identity.
  const exportTraces = traceExporter.export.bind(traceExporter);
  traceExporter.export = (spans, callback) => {
    void identity.then(
      () => exportTraces(spans, callback),
      (error: unknown) =>
        callback({
          code: core.ExportResultCode.FAILED,
          error: error instanceof Error ? error : new Error(String(error)),
        }),
    );
  };
  const exportMetrics = metricExporter.export.bind(metricExporter);
  metricExporter.export = (data, callback) => {
    void identity.then(
      () => exportMetrics(data, callback),
      (error: unknown) =>
        callback({
          code: core.ExportResultCode.FAILED,
          error: error instanceof Error ? error : new Error(String(error)),
        }),
    );
  };
  return new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME || 'station',
    resource: defaultResource().merge(
      resourceFromAttributes({
        ...resourceAttributes,
      }),
    ),
    traceExporter,
    // Station's durable logger is separate; NodeSDK otherwise enables OTLP logs.
    logRecordProcessors: [],
    metricReader: new PeriodicExportingMetricReader({
      exporter: metricExporter,
      exportIntervalMillis: 30_000,
    }),
    instrumentations: [
      new HttpInstrumentation({
        requestHook: (span, request) => {
          const method = ('method' in request ? request.method : '') || 'GET';
          const url = 'url' in request ? request.url || '/' : '/';
          const route = url
            .split('?')[0]
            .replace(/\/[0-9a-f]{8,}|\/[^/]*:[^/]+|\/[^/]+%3A[^/]*/gi, '/:id');
          span.updateName(`${method} ${route}`);
        },
      }),
      new AwsInstrumentation({ suppressInternalInstrumentation: true }),
    ],
  });
}

/** Providers register before the first await; export waits for identity I/O. */
export async function initializeTelemetry(
  options: InitializeTelemetryOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  // No endpoint means no identity file I/O, preserving inert-install behavior.
  if (!endpoint) return;

  const homeDir = options.homeDir ?? resolveHomeDir();
  assertHostedPersistenceBeforeSchemaSync(homeDir, env);
  ensureStationHomeSchemaSync(homeDir);
  const identity = persistedRandomIdentifierHash(
    homeDir,
    'otel-installation-id',
  );
  // Handle rejection even if SDK construction/start fails before the await.
  void identity.catch(() => {});
  const resourceAttributes = {
    [OTEL_INSTALLATION_ID_ATTRIBUTE]: identity,
    'os.type': platform(),
  };
  const sdk = (options.createSdk ?? createSdk)(resourceAttributes, endpoint);
  sdk.start();
  let shutdown: Promise<void> | undefined;
  const shutdownOwner = { shutdown: () => (shutdown ??= sdk.shutdown()) };
  activeTelemetrySdks.add(shutdownOwner);
  try {
    await identity;
  } catch (error) {
    void shutdownOwner
      .shutdown()
      .finally(() => activeTelemetrySdks.delete(shutdownOwner))
      .catch(() => {});
    throw error;
  }
  if (shutdown) return;
  (options.log ?? console.log)(
    `[telemetry] OTel exporting to ${endpoint} (installation identity configured)`,
  );
}

/** Returns no task for inert installs; configured SDKs share runtime teardown's budget. */
export function configuredTelemetryShutdownTask():
  | { name: string; shutdown: (signal: AbortSignal) => Promise<void> }
  | undefined {
  if (activeTelemetrySdks.size === 0) return undefined;
  return {
    name: 'OTLP telemetry',
    shutdown: async (signal) => {
      const sdks = [...activeTelemetrySdks];
      activeTelemetrySdks.clear();
      const settled = Promise.allSettled(sdks.map((sdk) => sdk.shutdown()));
      if (signal.aborted) return;
      await Promise.race([
        settled,
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
      ]);
    },
  };
}

// Do not make process boot await optional telemetry. Failures are intentionally
// contained: OTel cannot prevent Station from starting. They are NOT silent —
// a swallowed failure makes a broken exporter configuration indistinguishable
// from an unconfigured one, and an operator who set OTEL_EXPORTER_OTLP_ENDPOINT
// deliberately deserves to know it did not take.
void initializeTelemetry().catch((error) => {
  console.warn(
    '[telemetry] OTel did not start; Station continues without it:',
    error instanceof Error ? error.message : String(error),
  );
});
