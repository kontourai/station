import type {
  ConnectionConfig,
  ProviderConnectionConfig,
} from '@kontourai/station-contracts/tool';

export const API_KEY_CONFIGURED_FIELD = 'apiKeyConfigured';
export const API_KEY_CLEAR_FIELD = 'apiKeyClearRequested';

type ProviderConfigOwner = {
  config?: Record<string, unknown>;
};

/**
 * Provider responses may say that a secret exists, but must never return its
 * value. This marker is safe for device clients and lets an edit preserve the
 * saved secret without copying it through the browser.
 */
export function redactProviderSecrets<T extends ProviderConfigOwner>(
  connection: T,
): T {
  const config = connection.config ?? {};
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
  if (!apiKey) {
    const { [API_KEY_CONFIGURED_FIELD]: _configured, ...safeConfig } = config;
    return {
      ...connection,
      config: safeConfig,
    };
  }
  const { apiKey: _apiKey, ...safeConfig } = config;
  return {
    ...connection,
    config: {
      ...safeConfig,
      [API_KEY_CONFIGURED_FIELD]: Boolean(apiKey),
    },
  };
}

export function redactConnectionSecrets(
  connection: ConnectionConfig,
): ConnectionConfig {
  return connection.kind === 'model'
    ? redactProviderSecrets(connection)
    : connection;
}

/**
 * A client that received `apiKeyConfigured: true` can save another field
 * without receiving or resubmitting the secret. A non-empty new apiKey
 * deliberately replaces it. The response-only marker is never persisted.
 */
export function restoreProviderSecrets<T extends ProviderConfigOwner>(
  incoming: T,
  existing?: ProviderConfigOwner | null,
): T {
  const incomingConfig = incoming.config ?? {};
  const {
    [API_KEY_CONFIGURED_FIELD]: configured,
    [API_KEY_CLEAR_FIELD]: clearRequested,
    apiKey: incomingApiKey,
    ...persistedConfig
  } = incomingConfig;
  const replacement =
    typeof incomingApiKey === 'string' ? incomingApiKey.trim() : '';
  const existingApiKey =
    typeof existing?.config?.apiKey === 'string'
      ? existing.config.apiKey
      : undefined;

  return {
    ...incoming,
    config: {
      ...persistedConfig,
      ...(replacement
        ? { apiKey: replacement }
        : clearRequested !== true && configured === true && existingApiKey
          ? { apiKey: existingApiKey }
          : {}),
    },
  };
}

export function restoreConnectionSecrets(
  incoming: ConnectionConfig,
  existing?: ConnectionConfig | null,
): ConnectionConfig {
  return incoming.kind === 'model'
    ? (restoreProviderSecrets(
        incoming,
        existing?.kind === 'model' ? existing : null,
      ) as ConnectionConfig)
    : incoming;
}

export function redactLegacyProviderSecrets(
  connection: ProviderConnectionConfig,
): ProviderConnectionConfig {
  return redactProviderSecrets(connection) as ProviderConnectionConfig;
}

export function restoreLegacyProviderSecrets(
  incoming: ProviderConnectionConfig,
  existing?: ProviderConnectionConfig | null,
): ProviderConnectionConfig {
  return restoreProviderSecrets(incoming, existing) as ProviderConnectionConfig;
}
