/**
 * The OpenTelemetry SDK half of `telemetry.ts`: exporters, instrumentations
 * and the NodeSDK itself. It is loaded only when an endpoint is configured,
 * so an install without one never reads the SDK's code.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
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
import { TelemetryRequestError } from './services/telemetry-response.js';
import {
  beginOtelExport,
  type beginOtelTelemetryDelivery,
} from './telemetry-delivery-state.js';
import { OTEL_INSTALLATION_ID_ATTRIBUTE } from './telemetry-resource.js';

export type TelemetrySdk = Pick<NodeSDK, 'start' | 'shutdown'>;

export function createSdk(
  resourceAttributes: Record<string, string | Promise<string>>,
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
          const url =
            ('url' in request ? request.url : undefined) ||
            ('path' in request ? request.path : undefined) ||
            '/';
          const pathname = new URL(url, 'http://station.invalid').pathname;
          if (pathname.startsWith('/scheduler/jobs/')) {
            const suffix = pathname.match(
              /\/(logs|run|enable|disable)\/?$/,
            )?.[1];
            const route = `/scheduler/jobs/:target${suffix ? `/${suffix}` : ''}`;
            span.updateName(`${method} ${route}`);
            span.setAttributes({
              'http.route': route,
              'http.target': route,
              'http.url': route,
              'url.path': route,
              'url.query': '',
              'url.full': route,
            });
            return;
          }
          const route = (('url' in request ? request.url : undefined) || '/')
            .split('?')[0]
            .replace(/\/[0-9a-f]{8,}|\/[^/]*:[^/]+|\/[^/]+%3A[^/]*/gi, '/:id');
          span.updateName(`${method} ${route}`);
        },
      }),
      new AwsInstrumentation({ suppressInternalInstrumentation: true }),
    ],
  });
}
