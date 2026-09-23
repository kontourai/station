/**
 * Which sources `POST /api/plugins/validate` and the `validate_plugin` tool
 * accept (#2323 S1), shared so the two refuse the same things with the same
 * codes and the same result shape.
 *
 * Pure string checks on purpose: nothing here touches the filesystem, so a
 * refusal happens before any `stat` or `open`. That ordering is the point.
 * On Windows a UNC path (`\\host\share\...`) is absolute, and merely stat-ing
 * it opens an SMB session that can leak the user's NTLM credentials; on
 * macOS the automounter turns a stat of `/net/<host>/...` into an NFS mount.
 * The validate tool is auto-approved as read-only, so an agent must not be
 * able to cause either with a path.
 *
 * What this does NOT claim: that no path can ever reach a network
 * filesystem. A local directory can be a mount point the user configured, or
 * a symlink into one. The claim is narrower: validation never fetches or
 * clones, and the network-path forms a caller can name directly are refused.
 */
import { isAbsolute, resolve } from 'node:path';
import type {
  ConflictInfo,
  PluginComponent,
} from '@kontourai/station-contracts/plugin';

export interface PluginValidateDiagnostic {
  level: 'error' | 'warning';
  code: string;
  message: string;
  /** Where in the package the problem is, when the check knows. */
  component?: string;
  /** Context-safety findings, for a blocked manifest or prompt file. */
  findings?: unknown[];
}

export interface PluginValidateResult {
  /** True when no diagnostic is an error. */
  valid: boolean;
  source: string;
  format?: 'legacy' | 'agent-plugin-1.0';
  plugin?: {
    name: string;
    version: string;
    displayName?: string;
    description?: string;
  };
  diagnostics: PluginValidateDiagnostic[];
  components: PluginComponent[];
  conflicts: ConflictInfo[];
  /**
   * What an install will ask a person to approve. Informational: it is not a
   * consent basis, and `/install` refuses it without the digest of reviewed
   * bytes, which validation never computes.
   */
  permissions?: {
    required: string[];
    tiers: Array<{ permission: string; tier: string }>;
  };
  entrypoint?: { path: string; present: boolean };
  bundle: { checked: false; reason: string };
  note: string;
}

const PLUGIN_VALIDATE_BUNDLE_NOT_CHECKED =
  'Validation does not build. Station builds the bundle when a person installs the plugin; a build error is reported then.';

const PLUGIN_VALIDATE_NOTE =
  'Validation only. Nothing was installed, copied, or built, and dependencies were not resolved. A person installs a plugin from Plugins → Install plugin (or `station plugin install <source>`) after reviewing its preview and permissions.';

const REMOTE_SOURCE_REFUSED =
  'validate checks local folders; to check a git source, a person can run the install preview (Plugins → Install plugin).';

const NETWORK_PATH_REFUSED =
  'validate checks local folders and refuses network filesystem paths (UNC, device and automount paths such as /net/…); copy the plugin to a local folder first.';

/**
 * A URL, or an scp-style `user@host:path` git remote.
 */
function looksLikeRemoteUrl(source: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(source) ||
    /^[^/\\\s]+@[^/\\\s]+:/.test(source)
  );
}

/**
 * Prefixes whose resolution itself can open a network connection or reach
 * the Windows object namespace, checked on the RAW string because
 * `path.resolve` would otherwise fold them into something ordinary:
 * - two leading separators in any mix (`\\host\share`, `//host/share`),
 *   which covers UNC and the `\\?\UNC\…` and `\\.\…` device prefixes;
 * - a backslash followed by `?` or `.` (`\??\UNC\…`, the NT object prefix).
 */
function hasNetworkOrDevicePrefix(path: string): boolean {
  return /^[\\/]{2}/.test(path) || /^\\[?.]/.test(path);
}

/**
 * macOS automount roots, matched on the NORMALIZED path and ignoring case
 * (the default macOS filesystem is case-insensitive, so `/NET/h` is `/net/h`).
 */
function isAutomountPath(normalized: string): boolean {
  return /^\/(?:net|network)(?:\/|$)/i.test(normalized);
}

export type PluginValidateSourceResolution =
  | { ok: true; path: string }
  | { ok: false; diagnostic: PluginValidateDiagnostic };

/**
 * Decides whether `source` may be validated, and returns the NORMALIZED
 * path every later filesystem call must use. Normalizing first matters:
 * the kernel resolves `/./net/h`, `/tmp/../net/h` and `/NET/h` to the
 * automount root even though none of them starts with `/net/` as written.
 * No filesystem call happens here.
 */
export function resolvePluginValidateSource(
  raw: string,
): PluginValidateSourceResolution {
  const source = raw.trim();
  const refuse = (
    code: string,
    message: string,
  ): PluginValidateSourceResolution => ({
    ok: false,
    diagnostic: { level: 'error', code, message },
  });
  if (looksLikeRemoteUrl(source)) {
    return refuse('remote-source-refused', REMOTE_SOURCE_REFUSED);
  }
  if (hasNetworkOrDevicePrefix(source)) {
    return refuse('network-path-refused', NETWORK_PATH_REFUSED);
  }
  if (!isAbsolute(source)) {
    return refuse(
      'source-not-absolute',
      'Pass the absolute path of the plugin folder (the folder that contains plugin.json).',
    );
  }
  const normalized = resolve(source);
  if (hasNetworkOrDevicePrefix(normalized) || isAutomountPath(normalized)) {
    return refuse('network-path-refused', NETWORK_PATH_REFUSED);
  }
  return { ok: true, path: normalized };
}

/** The refusal for `source`, or null when it may be validated. */
export function refusePluginValidateSource(
  source: string,
): PluginValidateDiagnostic | null {
  const resolution = resolvePluginValidateSource(source);
  return resolution.ok ? null : resolution.diagnostic;
}

/** A complete {@link PluginValidateResult} carrying only `diagnostics`. */
export function pluginValidateResult(
  source: string,
  diagnostics: PluginValidateDiagnostic[],
  extra: Partial<Omit<PluginValidateResult, 'valid' | 'diagnostics'>> = {},
): PluginValidateResult {
  return {
    source,
    components: [],
    conflicts: [],
    bundle: { checked: false, reason: PLUGIN_VALIDATE_BUNDLE_NOT_CHECKED },
    note: PLUGIN_VALIDATE_NOTE,
    ...extra,
    diagnostics,
    valid: !diagnostics.some((entry) => entry.level === 'error'),
  };
}
