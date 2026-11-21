// Keep the CommonJS SDK graph dormant until a configured bootstrap needs it.
export function loadOtelSdkDependencies() {
  const {
    OTLPMetricExporter,
  }: typeof import('@opentelemetry/exporter-metrics-otlp-http') =
    require('@opentelemetry/exporter-metrics-otlp-http');
  const {
    OTLPTraceExporter,
  }: typeof import('@opentelemetry/exporter-trace-otlp-http') =
    require('@opentelemetry/exporter-trace-otlp-http');
  const {
    AwsInstrumentation,
  }: typeof import('@opentelemetry/instrumentation-aws-sdk') =
    require('@opentelemetry/instrumentation-aws-sdk');
  const {
    HttpInstrumentation,
  }: typeof import('@opentelemetry/instrumentation-http') =
    require('@opentelemetry/instrumentation-http');
  const {
    defaultResource,
    resourceFromAttributes,
  }: typeof import('@opentelemetry/resources') =
    require('@opentelemetry/resources');
  const {
    AggregationTemporality,
    PeriodicExportingMetricReader,
  }: typeof import('@opentelemetry/sdk-metrics') =
    require('@opentelemetry/sdk-metrics');
  const { core, NodeSDK }: typeof import('@opentelemetry/sdk-node') =
    require('@opentelemetry/sdk-node');

  return {
    OTLPMetricExporter,
    OTLPTraceExporter,
    AwsInstrumentation,
    HttpInstrumentation,
    defaultResource,
    resourceFromAttributes,
    AggregationTemporality,
    PeriodicExportingMetricReader,
    core,
    NodeSDK,
  };
}
