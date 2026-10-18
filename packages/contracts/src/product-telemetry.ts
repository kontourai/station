import type {
  PluginDailyPing,
  PluginTelemetryBatch,
  PluginTelemetryEvent,
} from './plugin-telemetry.js';
export const PRODUCT_TELEMETRY_ACKNOWLEDGEMENT_PROTOCOL = 2;
export const PRODUCT_TELEMETRY_ACKNOWLEDGEMENT_CAPABILITY =
  'productTelemetryAcknowledgement';

// Revision 2 corrects the disclosure's earlier overstatement of anonymity.
export const FULL_DISCLOSURE_WORDING_REVISION = 2;

export const TELEMETRY_TIERS = ['off', 'lite', 'full'] as const;
export type TelemetryTier = (typeof TELEMETRY_TIERS)[number];
export type TelemetryPublisherId =
  | 'kontour'
  | 'operator'
  | `publisher:${string}`;
export type TelemetryTierChoices = Partial<
  Record<TelemetryPublisherId, TelemetryTier>
>;
export interface TelemetryTierResolution {
  tier: TelemetryTier;
  reason: 'DNT' | 'policy' | 'default' | 'user' | 'disclosure' | 'environment';
}

/** A publisher's effective resolution alongside its separately saved choice. */
export interface TelemetryPublisherStatus extends TelemetryTierResolution {
  userChoice?: TelemetryTier;
  destination?: string;
  endpointConfigured?: boolean;
  liteInventoryRevision?: string;
  liteInventory?: Record<string, unknown>;
  fullInventoryRevision?: string;
  liteNoticeShown?: boolean;
}

/** Policies affect defaults only; an identifying stream is never a default. */
export function resolveTelemetryTier(input: {
  userChoice?: TelemetryTier;
  distributionDefault?: TelemetryTier;
  operatorPolicy?: TelemetryTier;
  doNotTrack?: string;
  hasFullDisclosure: boolean;
}): TelemetryTierResolution {
  if (
    input.doNotTrack !== undefined &&
    input.doNotTrack !== '' &&
    input.doNotTrack !== '0'
  )
    return { tier: 'off', reason: 'DNT' };
  if (input.userChoice !== undefined) {
    if (input.userChoice === 'full' && !input.hasFullDisclosure)
      return { tier: 'lite', reason: 'disclosure' };
    return { tier: input.userChoice, reason: 'user' };
  }
  const rank = { off: 0, lite: 1, full: 2 } as const;
  let tier: TelemetryTier = 'lite';
  for (const policy of [input.distributionDefault, input.operatorPolicy]) {
    if (policy !== undefined && rank[policy] < rank[tier]) tier = policy;
  }
  return { tier, reason: tier === 'lite' ? 'default' : 'policy' };
}

export const TELEMETRY_SURFACES = [
  'desktop',
  'web',
  'ios',
  'android',
  'cli',
] as const;
export const TELEMETRY_ENGINES = [
  'station',
  'acp',
  'bedrock',
  'claude',
  'codex',
  'muse',
  'ollama',
  'other',
] as const;
export const TELEMETRY_CHANNELS = [
  'stable',
  'preview',
  'nightly',
  'dev',
  'source-checkout',
] as const;
export const TELEMETRY_SETUP_STEPS = [
  'none',
  'welcome',
  'connection',
  'engine',
  'project',
  'pairing',
  'finish',
] as const;
export const TELEMETRY_COUNT_BUCKETS = ['0', '1', '2-3', '4+'] as const;
export const TELEMETRY_SETTING_CATEGORIES = [
  'appearance',
  'connections',
  'agents',
  'projects',
  'notifications',
  'privacy',
  'advanced',
  'other',
] as const;
export const TELEMETRY_FEEDBACK_REASONS = [
  'privacy',
  'too-much-data',
  'performance',
  'not-useful',
  'unexpected',
  'other',
  'skip',
] as const;
export type TelemetryFeedbackReason =
  (typeof TELEMETRY_FEEDBACK_REASONS)[number];
export interface TelemetryFeedback {
  publisher: TelemetryPublisherId;
  action: 'tier-lowered' | 'plugin-uninstalled';
  reason: TelemetryFeedbackReason;
}

/** Every Lite field, including bounds, participates in the shown-notice revision. */
export const STATION_DAILY_FIELDS = {
  event: { domain: ['station_daily'] },
  event_id: { domain: 'uuid-v4' },
  version: { domain: 'public-release-version-or-custom', maxLength: 64 },
  channel: { domain: [...TELEMETRY_CHANNELS, 'unknown'] },
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
    ],
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
    ],
  },
  surfaces_today: { domain: TELEMETRY_SURFACES, arrayMax: 5 },
  first_active_this_week: { domain: 'boolean' },
  first_active_this_month: { domain: 'boolean' },
  install_age_bucket: { domain: ['0d', '1-7d', '8-30d', '31-90d', '91d+'] },
  paired_devices_bucket: { domain: TELEMETRY_COUNT_BUCKETS },
  engines_used_today: { domain: TELEMETRY_ENGINES, arrayMax: 8 },
  distribution: {
    domain: 'public-registry-id-or-none-or-custom-or-unknown',
    maxLength: 128,
  },
  public_plugins_enabled: {
    domain: 'public-registry-id',
    arrayMax: 20,
    maxLength: 128,
  },
  private_plugins_bucket: { domain: TELEMETRY_COUNT_BUCKETS },
  branding_overridden: { domain: 'boolean' },
  home_replaced: { domain: 'boolean' },
  layouts_customized: { domain: 'boolean-or-unknown' },
  setup_abandoned_step: { domain: TELEMETRY_SETUP_STEPS },
  engine_connect_failures: { domain: 'engine-count-buckets', arrayMax: 8 },
  safe_mode_entered: { domain: 'count', max: 65535 },
  plugin_disabled_after_crash: { domain: 'count', max: 65535 },
} as const;

type DailyDomain<D> = D extends readonly string[]
  ? D[number]
  : D extends 'boolean-or-unknown'
    ? boolean | 'unknown'
    : D extends 'boolean'
      ? boolean
      : D extends 'count'
        ? number
        : D extends 'engine-count-buckets'
          ? {
              engine: (typeof TELEMETRY_ENGINES)[number];
              bucket: (typeof TELEMETRY_COUNT_BUCKETS)[number];
            }
          : string;
type DailyField<F extends { domain: unknown }> = F extends { arrayMax: number }
  ? DailyDomain<F['domain']>[]
  : DailyDomain<F['domain']>;
export type StationDailyPing = {
  [K in keyof typeof STATION_DAILY_FIELDS]: DailyField<
    (typeof STATION_DAILY_FIELDS)[K]
  >;
};
export interface TelemetryLiteNoticeReceipt {
  publisher: TelemetryPublisherId;
  inventoryRevision: string;
  shownAt: string;
}
export const TELEMETRY_OUTBOX_LIMITS = {
  retentionDays: 30,
  maxBytes: 5 * 1024 * 1024,
  eviction: 'oldest-first',
} as const;
export interface TelemetryOutboxEntry {
  publisher: TelemetryPublisherId;
  tier: 'lite' | 'full';
  recordedAt: string;
  outcome: 'sent' | 'dropped';
  reason:
    | 'acknowledged'
    | 'off'
    | 'DNT'
    | 'disclosure'
    | 'notice'
    | 'unconfigured'
    | 'overflow'
    | 'expired'
    | 'transport';
  payload:
    | StationDailyPing
    | PluginDailyPing
    | PluginTelemetryEvent
    | PluginTelemetryBatch
    | ProductTelemetryBatch
    | TelemetryFeedback
    | { event: 'telemetry_dropped'; count: number };
}

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
  pane_opened: {
    description: 'A public pane or a custom pane was opened.',
    properties: { pane: { domain: 'public-registry-id-or-custom' } },
  },
  plugin_installed: {
    description: 'A public or custom plugin was installed.',
    properties: { plugin: { domain: 'public-registry-id-or-custom' } },
  },
  plugin_removed: {
    description: 'A public or custom plugin was removed.',
    properties: { plugin: { domain: 'public-registry-id-or-custom' } },
  },
  setting_category_changed: {
    description: 'A setting category changed; no key or value is sent.',
    properties: { category: { domain: TELEMETRY_SETTING_CATEGORIES } },
  },
  client_connected: {
    description: 'A client connected without a device identifier.',
    properties: {
      surface: { domain: TELEMETRY_SURFACES },
      device_class: {
        domain: ['desktop', 'phone', 'tablet', 'server', 'other'] as const,
      },
      version: {
        domain: 'public-release-version-or-custom',
      },
    },
  },
  setup_abandoned: {
    description: 'Setup was abandoned at a classified step.',
    properties: { step: { domain: TELEMETRY_SETUP_STEPS } },
  },
  engine_connect_failed: {
    description: 'An engine connection failed without error text.',
    properties: { engine: { domain: TELEMETRY_ENGINES } },
  },
  safe_mode_entered: {
    description: 'Station entered safe mode.',
    properties: {
      reason: { domain: ['startup', 'plugin-crash', 'user', 'other'] as const },
    },
  },
  plugin_disabled_after_crash: {
    description: 'A public or custom plugin was disabled after a crash.',
    properties: { plugin: { domain: 'public-registry-id-or-custom' } },
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
    : D['domain'] extends
          | 'public-registry-id-or-custom'
          | 'public-release-version-or-custom'
      ? string
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
      'SHA-256 of a separate random installation UUID concatenated with the publisher ID and UTC YYYY-MM; rotates monthly and is not a person identity.',
    events: 'One through twenty inventory observations.',
  },
  observation: {
    event_id: 'Random UUID assigned once at observation; unchanged on retry.',
    event: 'One name from the classified event inventory.',
    occurred_at:
      'Canonical UTC producer wall-clock time when track was called, rounded down to the minute.',
    observed_at:
      'Canonical UTC producer wall-clock time at buffer admission, rounded down to the minute.',
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

/** Receiver acknowledgement returned only after the bounded storage transaction commits. */
export interface ProductTelemetryCommitReceipt {
  protocol: 'station-product-commit/v1';
  receiptId: string;
  sourceId: string;
  eventIds: string[];
  inserted: number;
  alreadyPresent: number;
  storedAt: string;
}

export interface ProductTelemetryProbeRequest {
  protocol: 'station-product-probe/v1';
  inventoryRevision: string;
}

/** A source-authorized storage query; no product observation or commit receipt is inserted. */
export interface ProductTelemetryProbeReceipt {
  protocol: 'station-product-probe/v1';
  sourceId: string;
  inventoryRevision: string;
  checkedAt: string;
  storage: 'postgres-schema-v1';
}
