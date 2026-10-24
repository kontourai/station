/** Build-time facts the bundle carries about itself. */
export interface StationCliBundleInfo {
  /** `packages/cli/package.json`'s version, frozen at build time. */
  version: string;
  /** Immutable source revision selected by the bundle build. */
  sourceSha: string;
  /** CLI build channel, deliberately independent from `STATION_CHANNEL`. */
  channel: string;
  /** Immutable UTC time when this executable was bundled. */
  builtAt?: string;
}

/** The bundle marker, or `undefined` when running from source. */
export function bundleInfo(): StationCliBundleInfo | undefined {
  const marker = (
    globalThis as { __STATION_CLI_BUNDLE__?: Partial<StationCliBundleInfo> }
  ).__STATION_CLI_BUNDLE__;
  if (
    !(
      marker &&
      typeof marker.version === 'string' &&
      typeof marker.sourceSha === 'string' &&
      typeof marker.channel === 'string'
    )
  ) {
    return undefined;
  }
  const builtAt = validBundleBuiltAt(marker.builtAt)
    ? marker.builtAt
    : undefined;
  return {
    version: marker.version,
    sourceSha: marker.sourceSha,
    channel: marker.channel,
    ...(builtAt === undefined ? {} : { builtAt }),
  };
}

function validBundleBuiltAt(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const canonical = value.includes('.') ? value : value.replace(/Z$/, '.000Z');
  return new Date(parsed).toISOString() === canonical;
}

/** Whether this process is the published, bundled `station` executable. */
export function isBundledDistribution(): boolean {
  return bundleInfo() !== undefined;
}

export const CONTRIBUTOR_COMMANDS: readonly string[] = [
  'build',
  'dev',
  'fresh',
  'home',
  'link',
  'service',
  'shortcut',
  'start',
  'stop',
  'upgrade',
];

/** One distribution authority supplies both refusal behaviour and help copy. */
export function bundledAvailabilityNote(): string[] {
  return [
    'Not available in the packaged client — these manage a Station checkout:',
    `  ${CONTRIBUTOR_COMMANDS.join(', ')}`,
    'Run them from the repo root as `./station <command>`.',
    'Local pairing offer/approval is supported with an existing Station home:',
    '  station environment offer | station environment access list|approve|deny',
    'Use `station environment access request` or `station setup existing <name> <host-url> --pair` from this client.',
  ];
}
