/**
 * Register configured providers synchronously; exporters wait for the persisted
 * installation identity without holding up Station startup.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { platform } from 'node:os';
import type { AppConfig } from '@kontourai/station-contracts/config';
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
import { observeOtelBootstrapConfig } from './domain/telemetry-bootstrap-config.js';
import { resolveOtelTelemetryConfiguration } from './domain/telemetry-configuration.js';
import { assertHostedPersistenceBeforeSchemaSync } from './runtime/bootstrap/hosted-persistence-boundary.js';
import {
  isSupervisedEnvironment,
  whenHomeAccessAllowed,
} from './runtime/bootstrap/supervisor-link.js';
import { persistedRandomIdentifierHash } from './services/persisted-random-identifier.js';
import { TelemetryRequestError } from './services/telemetry-response.js';
import {
  beginOtelExport,
  beginOtelTelemetryDelivery,
  failOtelTelemetryBootstrap,
} from './telemetry-delivery-state.js';
import { resolveHomeDir } from './utils/paths.js';

export const OTEL_INSTALLATION_ID_ATTRIBUTE = 'service.installation.id';

type TelemetrySdk = Pick<NodeSDK, 'start' | 'shutdown'>;
type TelemetryResourceAttributes = Record<string, string | Promise<string>>;
const activeTelemetrySdks = new Set<{
  shutdown: () => Promise<void>;
  fence: () => void;
}>();
export interface InitializeTelemetryOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  appConfig?: Pick<AppConfig, 'otelTelemetryEndpoint' | 'otelTelemetryKeyRef'>;
  createSdk?: (
    resourceAttributes: TelemetryResourceAttributes,
    endpoint: string,
  ) => TelemetrySdk;
  log?: (message: string) => void;
  /**
   * Holds the home writes (schema gate, installation identity) until this
   * settles; providers still register synchronously. A supervised generation
   * passes its promotion, since it loads while another generation owns the
   * home.
   */
  homeWritesAllowed?: Promise<void>;
}

function createSdk(
  resourceAttributes: TelemetryResourceAttributes,
  endpoint: string,
  delivery: ReturnType<typeof beginOtelTelemetryDelivery>,
): NodeSDK {
  const exportAuthority = new AsyncLocalStorage<{
    key?: string;
    assertCurrent: () => void;
  }>();
  const headers = async (): Promise<Record<string, string>> => {
    const credential = exportAuthority.getStore();
    if (!credential) throw new TelemetryRequestError('credential_unavailable');
    credential.assertCurrent();
    return credential.key ? { 'x-api-key': credential.key } : {};
  };
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
    const completed = beginOtelExport(delivery, 'traces');
    void identity
      .then(async () => {
        const credential = await delivery.credential!();
        credential.assertCurrent();
        exportAuthority.run(credential, () =>
          exportTraces(spans, (result) => {
            try {
              credential.assertCurrent();
            } catch {
              result = {
                code: core.ExportResultCode.FAILED,
                error: new TelemetryRequestError('credential_unavailable'),
              };
            }
            completed(result.code === core.ExportResultCode.SUCCESS);
            callback(result);
          }),
        );
      })
      .catch((error: unknown) => {
        completed(false);
        callback({
          code: core.ExportResultCode.FAILED,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
  };
  const exportMetrics = metricExporter.export.bind(metricExporter);
  metricExporter.export = (data, callback) => {
    const completed = beginOtelExport(delivery, 'metrics');
    void identity
      .then(async () => {
        const credential = await delivery.credential!();
        credential.assertCurrent();
        exportAuthority.run(credential, () =>
          exportMetrics(data, (result) => {
            try {
              credential.assertCurrent();
            } catch {
              result = {
                code: core.ExportResultCode.FAILED,
                error: new TelemetryRequestError('credential_unavailable'),
              };
            }
            completed(result.code === core.ExportResultCode.SUCCESS);
            callback(result);
          }),
        );
      })
      .catch((error: unknown) => {
        completed(false);
        callback({
          code: core.ExportResultCode.FAILED,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
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
  const homeDir = options.homeDir ?? resolveHomeDir();
  let saved: Pick<AppConfig, 'otelTelemetryEndpoint' | 'otelTelemetryKeyRef'>;
  try {
    assertHostedPersistenceBeforeSchemaSync(homeDir, env);
    saved = options.appConfig ?? observeOtelBootstrapConfig(homeDir);
  } catch (error) {
    failOtelTelemetryBootstrap();
    throw error;
  }
  const configuration = resolveOtelTelemetryConfiguration(saved, env);
  const endpoint = configuration.endpoint;
  // No endpoint means no identity file I/O, preserving inert-install behavior.
  if (!endpoint) return;
  for (const notice of configuration.notices)
    (options.log ?? console.warn)(
      `OTel environment: ${notice.code} (${notice.envVar}).`,
    );

  const delivery = beginOtelTelemetryDelivery(
    endpoint,
    configuration.key,
    saved,
  );
  let resolver:
    | Promise<
        import('./services/secrets/secret-binding-administration.js').FileSecretBindingAdministration
      >
    | undefined;
  delivery.credential = async (signal = delivery.credentialAbort.signal) => {
    const assertActive = () => {
      if (
        delivery.credentialAbort.signal.aborted ||
        signal.aborted ||
        delivery.status.phase === 'restart-required'
      )
        throw new TelemetryRequestError('credential_unavailable');
    };
    assertActive();
    // OTel merges standard environment headers even when a factory is supplied.
    // Saved destinations must not inherit those separately addressed credentials.
    if (
      (saved.otelTelemetryEndpoint || configuration.keyRef) &&
      [
        'OTEL_EXPORTER_OTLP_HEADERS',
        'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
        'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
      ].some((name) => process.env[name]?.trim())
    )
      throw new TelemetryRequestError('credential_unavailable');
    if (!configuration.keyRef)
      return { key: configuration.key, assertCurrent: assertActive };
    try {
      // This import reaches instruments, so it must remain after SDK.start().
      resolver ??= import(
        './services/secrets/secret-binding-administration.js'
      ).then(
        ({ FileSecretBindingAdministration }) =>
          new FileSecretBindingAdministration(homeDir, { environment: env }),
      );
      const credential = await (await resolver).resolveForTelemetry({
        id: configuration.keyRef,
        transport: 'otel',
        destination: endpoint,
        signal,
      });
      return {
        key: credential.key,
        assertCurrent: () => {
          assertActive();
          try {
            credential.assertCurrent();
          } catch {
            throw new TelemetryRequestError('credential_unavailable');
          }
        },
      };
    } catch {
      throw new TelemetryRequestError('credential_unavailable');
    }
  };
  const admitHome = () => {
    try {
      assertHostedPersistenceBeforeSchemaSync(homeDir, env);
      ensureStationHomeSchemaSync(homeDir);
    } catch (error) {
      delivery.status.phase = 'failed';
      delivery.status.identity = 'failed';
      throw error;
    }
  };
  // Exports already wait for the identity, so holding it holds every export.
  let identity: Promise<string>;
  if (options.homeWritesAllowed) {
    identity = options.homeWritesAllowed.then(() => {
      admitHome();
      return persistedRandomIdentifierHash(homeDir, 'otel-installation-id');
    });
  } else {
    admitHome();
    identity = persistedRandomIdentifierHash(homeDir, 'otel-installation-id');
  }
  // Handle rejection even if SDK construction/start fails before the await.
  void identity.then(
    () => {
      delivery.status.identity = 'ready';
    },
    () => {
      delivery.status.identity = 'failed';
    },
  );
  const resourceAttributes = {
    [OTEL_INSTALLATION_ID_ATTRIBUTE]: identity,
    'os.type': platform(),
  };
  let sdk: TelemetrySdk;
  try {
    sdk = options.createSdk
      ? options.createSdk(resourceAttributes, endpoint)
      : createSdk(resourceAttributes, endpoint, delivery);
    sdk.start();
    delivery.status.phase = 'initialized';
  } catch (error) {
    delivery.status.phase = 'failed';
    throw error;
  }
  let shutdown: Promise<void> | undefined;
  const fence = () => {
    delivery.probeAbort?.abort();
    delivery.credentialAbort.abort();
    if (
      delivery.status.phase !== 'failed' &&
      delivery.status.phase !== 'restart-required'
    )
      delivery.status.phase = 'stopped';
  };
  const shutdownOwner = {
    fence,
    shutdown: () => {
      delivery.probeAbort?.abort();
      if (!shutdown) shutdown = sdk.shutdown().finally(fence);
      return shutdown;
    },
  };
  activeTelemetrySdks.add(shutdownOwner);
  try {
    await identity;
    delivery.status.identity = 'ready';
  } catch (error) {
    delivery.status.identity = 'failed';
    delivery.status.phase = 'failed';
    void shutdownOwner
      .shutdown()
      .finally(() => activeTelemetrySdks.delete(shutdownOwner))
      .catch(() => {});
    throw error;
  }
  if (shutdown) return;
  (options.log ?? console.log)(
    '[telemetry] OTel exporters initialized (installation identity configured)',
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
      await new Promise<void>((resolve) => {
        const expire = () => {
          for (const sdk of sdks) sdk.fence();
          resolve();
        };
        signal.addEventListener('abort', expire, { once: true });
        if (signal.aborted) {
          signal.removeEventListener('abort', expire);
          expire();
        }
        void Promise.allSettled(sdks.map((sdk) => sdk.shutdown())).then(() => {
          signal.removeEventListener('abort', expire);
          resolve();
        });
      });
    },
  };
}

// Do not make process boot await optional telemetry. Failures are intentionally
// contained: OTel cannot prevent Station from starting. They are NOT silent —
// a swallowed failure makes a broken exporter configuration indistinguishable
// from an unconfigured one, and an operator who set OTEL_EXPORTER_OTLP_ENDPOINT
// deliberately deserves to know it did not take.
//
// A supervised generation is loaded while the previous one still owns the
// home, so its home writes wait for promotion. Registration does not: it
// stays synchronous with this module's evaluation in every mode, so the
// providers exist before the modules imported after this one create
// instruments.
void initializeTelemetry(
  isSupervisedEnvironment()
    ? { homeWritesAllowed: whenHomeAccessAllowed() }
    : {},
).catch((error) => {
  console.warn(
    '[telemetry] OTel did not start; Station continues without it:',
    error instanceof Error ? error.message : String(error),
  );
});
