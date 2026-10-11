export const PRODUCT_TELEMETRY_ACKNOWLEDGEMENT_PROTOCOL = 2;
export const PRODUCT_TELEMETRY_ACKNOWLEDGEMENT_CAPABILITY =
  'productTelemetryAcknowledgement';

/** The single public inventory for Station product usage telemetry. */
export const USAGE_TELEMETRY_EVENTS = {
  station_started: {
    description: 'Station completed startup.',
    properties: {
      version: {
        domain:
          'SemVer version (MAJOR.MINOR.PATCH, with optional prerelease/build metadata)',
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

export type ProductTelemetryEventName = keyof typeof USAGE_TELEMETRY_EVENTS;
export type UsageTelemetryEvent = ProductTelemetryEventName;
type UsageTelemetrySemVer =
  | `${number}.${number}.${number}`
  | `${number}.${number}.${number}-${string}`
  | `${number}.${number}.${number}+${string}`
  | `${number}.${number}.${number}-${string}+${string}`;
export type ProductTelemetryPropertyDefinition = {
  domain: readonly string[] | string;
};
type UsageTelemetryPropertyValue<D extends ProductTelemetryPropertyDefinition> =
  D['domain'] extends readonly string[]
    ? D['domain'][number]
    : UsageTelemetrySemVer;
export type UsageTelemetryProperties<E extends UsageTelemetryEvent> = {
  [K in keyof (typeof USAGE_TELEMETRY_EVENTS)[E]['properties']]: (typeof USAGE_TELEMETRY_EVENTS)[E]['properties'][K] extends infer D extends
    ProductTelemetryPropertyDefinition
    ? UsageTelemetryPropertyValue<D>
    : never;
};

/** Product reliability observations are separate from canonical personal usage receipts. */

/** Envelope disclosure and accepted field names share this authority. */
export const PRODUCT_TELEMETRY_ENVELOPE = {
  batch: {
    schema_version: 'Protocol version 1.',
    inventory_revision:
      'SHA-256 of the disclosed envelope and event inventory.',
    distinct_id:
      'SHA-256 of a separate random installation UUID; not a person identity.',
    events: 'One through twenty inventory observations.',
  },
  observation: {
    event_id: 'Random UUID assigned once at observation; unchanged on retry.',
    event: 'One name from the classified event inventory.',
    occurred_at:
      'Canonical UTC producer wall-clock time when track was called.',
    observed_at: 'Canonical UTC producer wall-clock time at buffer admission.',
    build:
      'Allowlisted immutable process build metadata; missing facts stay absent.',
    properties: 'Only the event-specific classified properties below.',
  },
  build: {
    version: 'SemVer application version, present on every event.',
    platform: 'Operating-system platform from the startup inventory.',
    arch: 'CPU architecture from the startup inventory.',
    sha: 'Optional full 40 or 64 hex Git hash, paired with sha_source.',
    sha_source:
      'Optional build-stamp or checkout; checkout does not identify served bundle bytes.',
    channel: 'Optional stable, preview, nightly, dev or source-checkout.',
    dirty: 'Optional boolean supplied by the immutable build stamp.',
  },
} as const;

export interface ProductTelemetryBuild {
  version: string;
  platform: string;
  arch: string;
  /** Present only with its declared provenance; checkout SHA is not a bundle stamp. */
  sha?: string;
  sha_source?: 'build-stamp' | 'checkout';
  channel?: 'stable' | 'preview' | 'nightly' | 'dev' | 'source-checkout';
  dirty?: boolean;
}

export interface ProductTelemetryObservation {
  event_id: string;
  event: ProductTelemetryEventName;
  /** Producer wall clock when track was called; not receiver arrival time. */
  occurred_at: string;
  /** Producer wall clock when the disclosed observation entered its buffer. */
  observed_at: string;
  build: ProductTelemetryBuild;
  properties: Record<string, string>;
}

export interface ProductTelemetryBatch {
  schema_version: 1;
  inventory_revision: string;
  distinct_id: string;
  events: ProductTelemetryObservation[];
}
