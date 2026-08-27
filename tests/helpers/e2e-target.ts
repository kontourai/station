type E2ETargetEnvironment = Record<string, string | undefined>;

function parseOrigin(value: string, variableName: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid absolute URL.`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${variableName} must use http or https.`);
  }
  if (url.username || url.password) {
    throw new Error(`${variableName} must not include credentials.`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${variableName} must be an origin without a path.`);
  }
  return url;
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

export function resolveE2EApiBase(
  env: E2ETargetEnvironment = process.env,
): string {
  const configuredApiBase = env.PW_API_BASE_URL?.trim();
  if (!configuredApiBase) {
    throw new Error(
      'PW_API_BASE_URL is required for E2E tests that call the Station API directly. Run the test through scripts/run-e2e-suite.mjs or provide the isolated API origin explicitly.',
    );
  }

  const apiUrl = parseOrigin(configuredApiBase, 'PW_API_BASE_URL');
  const scopedPort = env.STATION_PORT?.trim();
  if (scopedPort && effectivePort(apiUrl) !== scopedPort) {
    throw new Error(
      `PW_API_BASE_URL targets port ${effectivePort(apiUrl)}, but STATION_PORT scopes this run to port ${scopedPort}. Refusing to call a different Station instance.`,
    );
  }

  const configuredUiBase = env.PW_BASE_URL?.trim();
  if (configuredUiBase) {
    const uiUrl = parseOrigin(configuredUiBase, 'PW_BASE_URL');
    if (uiUrl.hostname !== apiUrl.hostname) {
      throw new Error(
        `PW_API_BASE_URL targets ${apiUrl.hostname}, but PW_BASE_URL targets ${uiUrl.hostname}. Refusing a cross-host E2E target.`,
      );
    }
  }

  return apiUrl.origin;
}
