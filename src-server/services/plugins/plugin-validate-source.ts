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
import { isAbsolute } from 'node:path';
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

export const PLUGIN_VALIDATE_BUNDLE_NOT_CHECKED =
  'Validation does not build. Station builds the bundle when a person installs the plugin; a build error is reported then.';

export const PLUGIN_VALIDATE_NOTE =
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
 * Paths whose resolution itself can open a network connection:
 * - two leading separators in any mix (`\\host\share`, `//host/share`),
 *   which covers UNC and the `\\?\UNC\…` and `\\.\…` device prefixes;
 * - macOS automount roots `/net/` and `/Network/`.
 */
function looksLikeNetworkPath(source: string): boolean {
  if (/^[\\/]{2}/.test(source)) return true;
  return /^\/(?:net|Network)(?:\/|$)/.test(source);
}

/** The refusal for `source`, or null when it is a local absolute path. */
export function refusePluginValidateSource(
  source: string,
): PluginValidateDiagnostic | null {
  if (looksLikeRemoteUrl(source)) {
    return {
      level: 'error',
      code: 'remote-source-refused',
      message: REMOTE_SOURCE_REFUSED,
    };
  }
  if (looksLikeNetworkPath(source)) {
    return {
      level: 'error',
      code: 'network-path-refused',
      message: NETWORK_PATH_REFUSED,
    };
  }
  if (!isAbsolute(source)) {
    return {
      level: 'error',
      code: 'source-not-absolute',
      message:
        'Pass the absolute path of the plugin folder (the folder that contains plugin.json).',
    };
  }
  return null;
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
