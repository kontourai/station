/**
 * OpenTelemetry SDK bootstrap — must be imported before all other modules.
 * Graceful no-op when OTEL_EXPORTER_OTLP_ENDPOINT is not set.
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
import { NodeSDK } from '@opentelemetry/sdk-node';
import { persistedRandomIdentifierHash } from './services/persisted-random-identifier.js';
import { resolveHomeDir } from './utils/paths.js';

export const OTEL_INSTALLATION_ID_ATTRIBUTE = 'service.installation.id';

type TelemetrySdk = Pick<NodeSDK, 'start' | 'shutdown'>;
const activeTelemetrySdks = new Set<TelemetrySdk>();
export interface InitializeTelemetryOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  createInstallationIdHash?: (
    homeDir: string,
    filename: string,
  ) => Promise<string>;
  createSdk?: (
    resourceAttributes: Record<string, string>,
    endpoint: string,
  ) => TelemetrySdk;
  log?: (message: string) => void;
}

function createSdk(
  resourceAttributes: Record<string, string>,
  endpoint: string,
): NodeSDK {
  const telemetryApiKey = process.env.STATION_TELEMETRY_API_KEY;
  const headers = telemetryApiKey
    ? { 'x-api-key': telemetryApiKey }
    : undefined;
  return new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME || 'station',
    resource: defaultResource().merge(
      resourceFromAttributes({
        ...resourceAttributes,
      }),
    ),
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint}/v1/traces`,
      headers,
    }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `${endpoint}/v1/metrics`,
        headers,
        temporalityPreference: AggregationTemporality.DELTA,
      }),
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

/** Resolves the exact non-identifying attributes attached to every OTel signal. */
export async function resolveOtelResourceAttributes(
  homeDir: string,
  createInstallationIdHash = persistedRandomIdentifierHash,
): Promise<Record<string, string>> {
  return {
    [OTEL_INSTALLATION_ID_ATTRIBUTE]: await createInstallationIdHash(
      homeDir,
      'otel-installation-id',
    ),
    'os.type': platform(),
  };
}

/** Starts configured OTel after its non-identifying installation id is ready. */
export async function initializeTelemetry(
  options: InitializeTelemetryOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  // No endpoint means no identity file I/O, preserving inert-install behavior.
  if (!endpoint) return;

  const resourceAttributes = await resolveOtelResourceAttributes(
    options.homeDir ?? resolveHomeDir(),
    options.createInstallationIdHash ?? persistedRandomIdentifierHash,
  );
  const sdk = (options.createSdk ?? createSdk)(resourceAttributes, endpoint);
  sdk.start();
  activeTelemetrySdks.add(sdk);
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
