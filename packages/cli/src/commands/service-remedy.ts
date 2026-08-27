/**
 * Render a service reinstall command only when the installed manifest carries
 * every setting that `service install` would otherwise replace.  A partial
 * command is dangerous: it may select another Station home or reset a
 * user-selected feature configuration.
 */
export interface ServiceInstallConfiguration {
  allowedOrigins?: unknown;
  baseDir?: unknown;
  features?: unknown;
  host?: unknown;
  instanceId?: unknown;
  serverPort?: unknown;
  uiPort?: unknown;
}

function shellArgument(value: string): string {
  // Comma included: feature lists are comma-separated and a comma is not a
  // shell metacharacter outside brace expansion, so quoting them adds noise
  // to a command the operator is meant to read and paste.
  if (/^[A-Za-z0-9_./:@,=-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/**
 * Returns null for registrations written before the complete configuration
 * was persisted.  Those registrations must be inspected by the operator;
 * guessing an omitted setting would silently change the service.
 */
export function renderServiceInstallRemedy(
  configuration: ServiceInstallConfiguration,
  fallbackBaseDir?: string,
): string | null {
  const baseDir = configuration.baseDir ?? fallbackBaseDir;
  if (
    typeof configuration.instanceId !== 'string' ||
    typeof baseDir !== 'string' ||
    typeof configuration.serverPort !== 'number' ||
    typeof configuration.uiPort !== 'number' ||
    typeof configuration.host !== 'string' ||
    (configuration.features !== null &&
      typeof configuration.features !== 'string') ||
    !Array.isArray(configuration.allowedOrigins) ||
    configuration.allowedOrigins.some((origin) => typeof origin !== 'string')
  ) {
    return null;
  }

  const args = [
    `--instance=${shellArgument(configuration.instanceId)}`,
    `--base=${shellArgument(baseDir)}`,
    `--port=${configuration.serverPort}`,
    `--ui-port=${configuration.uiPort}`,
    `--host=${shellArgument(configuration.host)}`,
    ...(configuration.features === null
      ? []
      : [`--features=${shellArgument(configuration.features)}`]),
    ...configuration.allowedOrigins.map(
      (origin) => `--allowed-origin=${shellArgument(origin)}`,
    ),
  ];
  return `station service install ${args.join(' ')}`;
}

/** Render a read-only follow-up against the same Station home, when known. */
export function renderServiceStatusCommand(
  configuration: ServiceInstallConfiguration,
  fallbackBaseDir?: string,
): string | null {
  const baseDir = configuration.baseDir ?? fallbackBaseDir;
  if (
    typeof configuration.instanceId !== 'string' ||
    typeof baseDir !== 'string'
  ) {
    return null;
  }
  return `station service status --instance=${shellArgument(configuration.instanceId)} --base=${shellArgument(baseDir)}`;
}
