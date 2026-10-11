import type { AppConfig } from '@kontourai/station-contracts/config';
import {
  APP_SETTINGS_REGISTRY,
  type SettingDefinition,
} from '@kontourai/station-contracts/settings-registry';
import {
  resolveEnvironmentValue,
  resolveSettingEnvironment,
} from './settings-environment.js';

export function resolveProductTelemetryEnabled(
  config: AppConfig,
  environment: NodeJS.ProcessEnv,
) {
  if (config.telemetryEnabled !== undefined)
    return {
      enabled: config.telemetryEnabled,
      source: 'config' as const,
      notices: [],
    };
  const definition: SettingDefinition = APP_SETTINGS_REGISTRY.find(
    (setting) => setting.key === 'telemetryEnabled',
  )!;
  const resolved = resolveSettingEnvironment(definition, environment);
  return {
    enabled:
      resolved.value === undefined
        ? definition.defaultValue === true
        : resolved.value === true,
    source: resolved.envVar ? ('env' as const) : ('default' as const),
    notices: resolved.notices,
  };
}

export function resolveProductTelemetryEnvironment(
  environment: NodeJS.ProcessEnv,
) {
  return {
    endpoint: resolveEnvironmentValue(
      'STATION_PRODUCT_TELEMETRY_ENDPOINT',
      ['STATION_TELEMETRY_ENDPOINT'],
      environment,
      (raw) => raw,
    ),
    key: resolveEnvironmentValue(
      'STATION_PRODUCT_TELEMETRY_KEY',
      ['STATION_USAGE_TELEMETRY_KEY'],
      environment,
      (raw) => raw,
    ),
  };
}

export function resolveOtelTelemetryEnvironment(
  environment: NodeJS.ProcessEnv,
) {
  return {
    endpoint: environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || undefined,
    key: resolveEnvironmentValue(
      'STATION_OTEL_API_KEY',
      ['STATION_TELEMETRY_API_KEY'],
      environment,
      (raw) => raw,
    ),
  };
}

export function resolveOtelTelemetryConfiguration(
  config: Pick<AppConfig, 'otelTelemetryEndpoint' | 'otelTelemetryKeyRef'>,
  environment: NodeJS.ProcessEnv,
) {
  const fromEnvironment = resolveOtelTelemetryEnvironment(environment);
  const savedEndpoint = config.otelTelemetryEndpoint?.trim();
  const keyRef = config.otelTelemetryKeyRef?.trim() || undefined;
  return {
    endpoint: savedEndpoint || fromEnvironment.endpoint,
    keyRef,
    key: savedEndpoint || keyRef ? undefined : fromEnvironment.key.value,
    notices: savedEndpoint || keyRef ? [] : fromEnvironment.key.notices,
  };
}
