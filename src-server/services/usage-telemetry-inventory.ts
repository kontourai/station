import { createHash } from 'node:crypto';

/** The single public inventory for Station product usage telemetry. */
export const USAGE_TELEMETRY_EVENTS = {
  station_started: {
    description: 'Station completed startup.',
    properties: {
      version: {
        domain:
          'SemVer version (MAJOR.MINOR.PATCH, with optional prerelease/build metadata)',
        validate: (value: string) =>
          /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
            value,
          ),
      },
      platform: {
        domain: [
          'aix',
          'android',
          'cygwin',
          'darwin',
          'freebsd',
          'haiku',
          'linux',
          'netbsd',
          'openbsd',
          'sunos',
          'win32',
        ] as const,
      },
      arch: {
        domain: [
          'arm',
          'arm64',
          'ia32',
          'loong64',
          'mips',
          'mipsel',
          'ppc',
          'ppc64',
          'riscv64',
          's390',
          's390x',
          'x64',
        ] as const,
      },
    },
  },
  session_recovery: {
    description: 'A session recovery reached an existing classified outcome.',
    properties: {
      failure_kind: {
        domain: [
          'authentication',
          'capacity',
          'rate-limit',
          'unknown',
        ] as const,
      },
      decision: {
        domain: [
          'unsupported',
          'reconnect',
          'manual',
          'retry-now',
          'wait-until-reset',
        ] as const,
      },
      outcome: {
        domain: [
          'armed',
          'resumed',
          'succeeded',
          'failed',
          'canceled',
          'manual',
          'unsupported',
          'compensation-required',
          'indeterminate',
        ] as const,
      },
    },
  },
  engine_turn: {
    description: 'An engine turn reached a terminal outcome.',
    properties: {
      engine: {
        domain: [
          'station',
          'acp',
          'bedrock',
          'claude',
          'codex',
          'muse',
          'ollama',
          'other',
        ] as const,
      },
      outcome: {
        // archive#3451 finding 5: 'failed' added alongside the existing pair
        // — a genuine turn-scoped failure (a non-deferred `runtime.error`
        // carrying a `turnId`) is a terminal outcome the description already
        // claims to cover and previously was not.
        domain: ['completed', 'aborted', 'failed'] as const,
      },
    },
  },
} as const;

export type UsageTelemetryEvent = keyof typeof USAGE_TELEMETRY_EVENTS;
export type UsageTelemetrySemVer =
  | `${number}.${number}.${number}`
  | `${number}.${number}.${number}-${string}`
  | `${number}.${number}.${number}+${string}`
  | `${number}.${number}.${number}-${string}+${string}`;
type PropertyDefinition = {
  domain: readonly string[] | string;
  validate?: (value: string) => boolean;
};
type UsageTelemetryPropertyValue<D extends PropertyDefinition> =
  D['domain'] extends readonly string[]
    ? D['domain'][number]
    : UsageTelemetrySemVer;
export type UsageTelemetryProperties<E extends UsageTelemetryEvent> = {
  [K in keyof (typeof USAGE_TELEMETRY_EVENTS)[E]['properties']]: (typeof USAGE_TELEMETRY_EVENTS)[E]['properties'][K] extends infer D extends
    PropertyDefinition
    ? UsageTelemetryPropertyValue<D>
    : never;
};

export function renderUsageTelemetryInventory(): string {
  return Object.entries(USAGE_TELEMETRY_EVENTS)
    .map(([event, definition]) => {
      const eventDefinition = definition as {
        description: string;
        properties: Record<string, PropertyDefinition>;
      };
      const properties = Object.entries(eventDefinition.properties)
        .map(
          ([property, definition]) =>
            `| \`${property}\` | ${Array.isArray(definition.domain) ? definition.domain.map((value) => `\`${value}\``).join(', ') : definition.domain} |`,
        )
        .join('\n');
      return `## \`${event}\`\n\n${eventDefinition.description}\n\n| Property | Permitted value |\n| --- | --- |\n${properties}`;
    })
    .join('\n\n');
}

/** A receipt covers this exact published inventory, not a vague telemetry policy. */
export const USAGE_TELEMETRY_INVENTORY_REVISION = createHash('sha256')
  .update(renderUsageTelemetryInventory())
  .digest('hex');

/** Fails loudly if an implementation and the published inventory diverge. */
export function assertUsageTelemetryInventoryContract(
  event: string,
  properties: Record<string, unknown>,
): void {
  const definition = USAGE_TELEMETRY_EVENTS[event as UsageTelemetryEvent];
  if (!definition)
    throw new Error(
      `Usage telemetry inventory drift: event "${event}" is not published.`,
    );
  const eventDefinition = definition as unknown as {
    properties: Record<string, PropertyDefinition>;
  };
  for (const property of Object.keys(properties)) {
    if (!(property in eventDefinition.properties))
      throw new Error(
        `Usage telemetry inventory drift: property "${event}.${property}" is not published.`,
      );
  }
  for (const property of Object.keys(eventDefinition.properties)) {
    if (!(property in properties))
      throw new Error(
        `Usage telemetry inventory drift: published property "${event}.${property}" is missing from code.`,
      );
  }
  for (const [property, value] of Object.entries(properties)) {
    const propertyDefinition = eventDefinition.properties[property];
    if (typeof value !== 'string')
      throw new Error(
        `Usage telemetry inventory drift: property "${event}.${property}" must be a string.`,
      );
    const allowed = propertyDefinition.domain;
    const valid = Array.isArray(allowed)
      ? (allowed as readonly string[]).includes(value)
      : (('validate' in propertyDefinition &&
          propertyDefinition.validate?.(value)) ??
        false);
    if (!valid)
      throw new Error(
        `Usage telemetry inventory drift: property "${event}.${property}" has invalid value "${value}"; permitted: ${Array.isArray(allowed) ? allowed.join(', ') : allowed}.`,
      );
  }
}
