import type { AppConfig } from '@kontourai/station-contracts/config';
import {
  resolveTelemetryTier,
  TELEMETRY_TIERS,
  type TelemetryPublisherId,
  type TelemetryPublisherStatus,
  type TelemetryTier,
} from '@kontourai/station-contracts/product-telemetry';
import { APP_SETTINGS_REGISTRY } from '@kontourai/station-contracts/settings-registry';
import {
  resolveEnvironmentValue,
  resolveSettingEnvironment,
} from './settings-environment.js';
import { STATION_AUTHOR_TELEMETRY_ENDPOINT } from './telemetry-build-constants.js';

export interface ResolvedTelemetryConfiguration {
  publishers: Record<
    TelemetryPublisherId,
    TelemetryPublisherStatus & {
      source: 'config' | 'env' | 'default';
    }
  >;
  authorEndpoint: string | undefined;
  source: 'config' | 'env' | 'default';
  notices: ReturnType<typeof resolveSettingEnvironment>['notices'];
}

export function resolveTelemetryConfiguration(
  config: AppConfig,
  environment: NodeJS.ProcessEnv,
  disclosures: Partial<Record<TelemetryPublisherId, boolean>> = {},
  policies: Partial<
    Record<
      TelemetryPublisherId,
      { distributionDefault?: TelemetryTier; operatorPolicy?: TelemetryTier }
    >
  > = {},
  publisherIds: TelemetryPublisherId[] = [],
): ResolvedTelemetryConfiguration {
  const tierEnvironment = resolveEnvironmentValue<TelemetryTier>(
    'STATION_TELEMETRY_TIER',
    [],
    environment,
    (raw) => TELEMETRY_TIERS.find((tier) => tier === raw),
  );
  const legacyDefinition = APP_SETTINGS_REGISTRY.find(
    (setting) => setting.key === 'telemetryEnabled',
  )!;
  const legacyEnvironment = resolveSettingEnvironment(
    legacyDefinition,
    environment,
  );
  const resolvePublisher = (
    publisher: TelemetryPublisherId,
  ): ResolvedTelemetryConfiguration['publishers']['operator'] => {
    const acknowledged = disclosures[publisher] === true;
    const userChoice =
      config.telemetryTier?.[publisher] ??
      (config.telemetryTier === undefined &&
      config.telemetryEnabled !== undefined
        ? config.telemetryEnabled === false
          ? 'off'
          : publisher === 'operator' && acknowledged
            ? 'full'
            : 'lite'
        : undefined);
    const environmentTier =
      tierEnvironment.value ??
      (legacyEnvironment.value === false
        ? 'off'
        : legacyEnvironment.value === true
          ? 'lite'
          : undefined);
    const resolved = resolveTelemetryTier({
      ...policies[publisher],
      operatorPolicy:
        config.telemetryPublisherPolicy?.[publisher] ??
        policies[publisher]?.operatorPolicy,
      distributionDefault:
        environmentTier === 'off'
          ? 'off'
          : policies[publisher]?.distributionDefault,
      userChoice,
      doNotTrack: environment.DO_NOT_TRACK,
      hasFullDisclosure: acknowledged,
    });
    const source =
      userChoice !== undefined
        ? 'config'
        : environmentTier !== undefined
          ? 'env'
          : 'default';
    return {
      ...resolved,
      ...(source === 'env' &&
      (resolved.reason === 'default' || resolved.reason === 'policy')
        ? { reason: 'environment' as const }
        : {}),
      source,
      ...(userChoice !== undefined ? { userChoice } : {}),
    };
  };
  const publishers: ResolvedTelemetryConfiguration['publishers'] = {
    ...Object.fromEntries(publisherIds.map((id) => [id, resolvePublisher(id)])),
    kontour: resolvePublisher('kontour'),
    operator: resolvePublisher('operator'),
  };
  return {
    publishers,
    authorEndpoint: STATION_AUTHOR_TELEMETRY_ENDPOINT || undefined,
    // Compatibility projection for clients of the former operator-only resolver.
    source: publishers.operator.source,
    notices: [...tierEnvironment.notices, ...legacyEnvironment.notices],
  };
}

/** Compatibility projection for the existing acknowledged operator event stream. */
export function resolveProductTelemetryEnabled(
  config: AppConfig,
  environment: NodeJS.ProcessEnv,
  hasFullDisclosure = false,
): {
  enabled: boolean;
  source: ResolvedTelemetryConfiguration['source'];
  notices: ResolvedTelemetryConfiguration['notices'];
} {
  const resolved = resolveTelemetryConfiguration(config, environment, {
    operator: hasFullDisclosure,
  });
  return {
    enabled: resolved.publishers.operator.tier === 'full',
    source: resolved.source,
    notices: resolved.notices,
  };
}

export function resolveProductTelemetryEnvironment(
  environment: NodeJS.ProcessEnv,
): {
  endpoint: ReturnType<typeof resolveEnvironmentValue<string>>;
  key: ReturnType<typeof resolveEnvironmentValue<string>>;
} {
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

function resolveOtelTelemetryEnvironment(environment: NodeJS.ProcessEnv) {
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
): {
  endpoint: string | undefined;
  keyRef: string | undefined;
  key: string | undefined;
  notices: ReturnType<typeof resolveEnvironmentValue<string>>['notices'];
} {
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
