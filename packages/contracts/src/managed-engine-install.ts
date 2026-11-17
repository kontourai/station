/**
 * An engine runtime Station installs itself, from a pinned manifest, with a
 * person's explicit consent, and runs from a built-in descriptor's
 * `managedRuntime` (see `@kontourai/station-contracts/acp`).
 *
 * Trust flows from the pin: the manifest's sha256 is checked before any
 * artifact is fetched, then each artifact's size and sha256, then entry
 * names before extraction, then the extracted tree. Nothing auto-updates;
 * a new version is a new pin in a reviewed change.
 *
 * Shapes and pure helpers only; the installer belongs to the server.
 */

/** Host platforms a pin can name: `<process.platform>-<arch>`, or a universal build. */
export type ManagedInstallPlatform =
  | 'darwin-universal'
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-x64'
  | 'linux-arm64'
  | 'win32-x64';

export const MANAGED_INSTALL_PLATFORMS: readonly ManagedInstallPlatform[] =
  Object.freeze([
    'darwin-universal',
    'darwin-arm64',
    'darwin-x64',
    'linux-x64',
    'linux-arm64',
    'win32-x64',
  ]);

/** One downloadable artifact, pinned by digest and size. */
export interface ManagedInstallArtifact {
  /** https only. */
  readonly url: string;
  /** Lowercase hex. */
  readonly sha256: string;
  readonly size: number;
}

/**
 * A runtime build the engine needs (for example a Node build). `electron-builtin`
 * is refused: Station does not run an engine on its own Electron runtime.
 */
export interface ManagedRuntimeBuild extends ManagedInstallArtifact {
  readonly runtime: string;
  readonly version: string;
  readonly platform: ManagedInstallPlatform;
}

/**
 * What a reviewed change pins. `installId` keys the install and the
 * connection that runs it, never the executable name: two engines can both
 * launch `node`.
 */
export interface ManagedInstallPin {
  readonly installId: string;
  readonly version: string;
  /** https only. */
  readonly manifestUrl: string;
  /** The trust root. Lowercase hex. */
  readonly manifestSha256: string;
  readonly platforms: readonly ManagedInstallPlatform[];
  readonly runtimeBuilds?: readonly ManagedRuntimeBuild[];
}

/** The manifest the pin's digest covers, as read after that digest matched. */
export interface EngineInstallManifest {
  readonly installId: string;
  readonly version: string;
  readonly artifacts: Readonly<
    Partial<Record<ManagedInstallPlatform, ManagedInstallArtifact>>
  >;
  /** The entry script, relative to the extracted root. */
  readonly entry: string;
  readonly runtimeBuilds?: readonly ManagedRuntimeBuild[];
}

/** Where an installed engine runs from. Absolute paths on the Station host. */
export interface ManagedInstallEntry {
  readonly runtime: string;
  readonly script: string;
}

export type ManagedInstallFailure =
  | 'manifest-digest-mismatch'
  | 'artifact-digest-mismatch'
  | 'artifact-size-mismatch'
  | 'unsafe-entry-name'
  | 'tree-verification-failed'
  | 'runtime-refused'
  | 'download-failed'
  | 'consent-required';

export type ManagedInstallState =
  | { readonly kind: 'not-installed' }
  | {
      readonly kind: 'installing';
      /** ISO 8601. */
      readonly startedAt: string;
      /** Bytes fetched so far, across every artifact of this install. */
      readonly receivedBytes?: number;
      /** Bytes the pinned artifacts for this host add up to. */
      readonly totalBytes?: number;
    }
  | {
      readonly kind: 'installed';
      readonly version: string;
      readonly entry: ManagedInstallEntry;
    }
  | {
      readonly kind: 'failed';
      readonly reason: ManagedInstallFailure;
      readonly detail?: string;
    }
  | { readonly kind: 'unsupported-platform'; readonly platform: string };

/** The argv token a descriptor's `managedRuntime.argv` uses for the entry script. */
export const MANAGED_RUNTIME_SCRIPT_TOKEN = '{script}' as const;

/**
 * The `command` a built-in managed-runtime entry (and a connection saved from
 * it) carries: `station-managed:<installId>`. It names no program on PATH;
 * Station resolves it at launch to the install's runtime and the
 * descriptor's argv. It is how a connection is keyed to its install rather
 * than to the runtime's executable name, which two engines can share.
 */
export const MANAGED_RUNTIME_COMMAND_PREFIX = 'station-managed:' as const;

export function managedRuntimeCommand(installId: string): string {
  if (!isManagedInstallId(installId))
    throw new Error('installId is not a managed install id');
  return `${MANAGED_RUNTIME_COMMAND_PREFIX}${installId}`;
}

/** The install id a managed-runtime command names, or undefined for any other command. */
export function managedRuntimeInstallIdOf(
  command: unknown,
): string | undefined {
  if (
    typeof command !== 'string' ||
    !command.startsWith(MANAGED_RUNTIME_COMMAND_PREFIX)
  )
    return undefined;
  const id = command.slice(MANAGED_RUNTIME_COMMAND_PREFIX.length);
  return isManagedInstallId(id) ? id : undefined;
}

const INSTALL_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A lowercase id of letters, digits and inner hyphens, at most 64 characters. */
export function isManagedInstallId(value: unknown): value is string {
  return typeof value === 'string' && INSTALL_ID.test(value);
}

/** Problems with a pin; empty when it is usable. */
export function validateManagedInstallPin(pin: unknown): string[] {
  if (pin === null || typeof pin !== 'object' || Array.isArray(pin))
    return ['pin must be an object'];
  const value = pin as Record<string, unknown>;
  const errors: string[] = [];
  if (!isManagedInstallId(value.installId))
    errors.push('installId is not valid');
  if (typeof value.version !== 'string' || !value.version.trim())
    errors.push('version is required');
  if (!isHttpsUrl(value.manifestUrl))
    errors.push('manifestUrl must be an https URL');
  if (
    typeof value.manifestSha256 !== 'string' ||
    !SHA256_HEX.test(value.manifestSha256)
  )
    errors.push('manifestSha256 must be 64 lowercase hex characters');
  if (
    !Array.isArray(value.platforms) ||
    value.platforms.length === 0 ||
    value.platforms.some(
      (platform) =>
        !(MANAGED_INSTALL_PLATFORMS as readonly unknown[]).includes(platform),
    )
  )
    errors.push('platforms must list known platforms');
  if (value.runtimeBuilds !== undefined) {
    if (!Array.isArray(value.runtimeBuilds)) {
      errors.push('runtimeBuilds must be a list');
    } else {
      value.runtimeBuilds.forEach((build, index) => {
        const at = `runtimeBuilds[${index}]`;
        if (build === null || typeof build !== 'object') {
          errors.push(`${at} must be an object`);
          return;
        }
        const entry = build as Record<string, unknown>;
        if (entry.runtime === 'electron-builtin')
          errors.push(`${at}: electron-builtin is refused`);
        if (!isHttpsUrl(entry.url))
          errors.push(`${at}.url must be an https URL`);
        if (typeof entry.sha256 !== 'string' || !SHA256_HEX.test(entry.sha256))
          errors.push(`${at}.sha256 must be 64 lowercase hex characters`);
        if (
          typeof entry.size !== 'number' ||
          !Number.isSafeInteger(entry.size) ||
          entry.size <= 0
        )
          errors.push(`${at}.size must be a positive integer`);
      });
    }
  }
  return errors;
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}
