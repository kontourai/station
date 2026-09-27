import type {
  PluginInstallationReadiness,
  PluginInstallationRevision,
  PluginInstallResult,
  PluginManifest,
  PluginPermissionPrompt,
  RejectedInstalledPluginRecord,
} from '@kontourai/station-contracts/plugin';
import {
  type ClientRequestOptions,
  envelopeErrorCode,
  envelopeErrorMessage,
  getJson,
  mutateJson,
  StationHttpError,
} from './http';

export type InstalledPluginRecord =
  | (PluginManifest & {
      hasBundle?: boolean;
      retainedOnRemoval?: boolean;
      installationReadiness?: PluginInstallationReadiness;
    })
  | RejectedInstalledPluginRecord;

function isPluginInstallationReadiness(
  value: unknown,
): value is PluginInstallationReadiness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.state === 'pending'
    ? row.recovery === 'review' && exactFields(row, ['state', 'recovery'])
    : (row.state === 'ready' || row.state === 'unavailable') &&
        exactFields(row, ['state']);
}

const REJECTION_CODES = new Set([
  'manifest-missing',
  'manifest-unreadable',
  'malformed-json',
  'unsafe-manifest-content',
  'invalid-plugin-name',
  'reserved-plugin-name',
  'missing-version',
  'invalid-workspace-panes',
  'invalid-manifest',
]);
function isUnsafePublicCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function exactFields(value: Record<string, unknown>, fields: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length &&
    actual.every((field, index) => field === expected[index])
  );
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    !Array.from(value).some(isUnsafePublicCharacter)
  );
}

function boundedDirectoryName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255;
}

function isRejectedInstalledPlugin(value: Record<string, unknown>): boolean {
  if (
    !exactFields(value, ['status', 'name', 'displayName', 'rejection']) ||
    value.status !== 'rejected' ||
    !boundedDirectoryName(value.name) ||
    !boundedText(value.displayName, 255) ||
    !value.rejection ||
    typeof value.rejection !== 'object' ||
    Array.isArray(value.rejection)
  ) {
    return false;
  }
  const rejection = value.rejection as Record<string, unknown>;
  if (
    !exactFields(rejection, ['code', 'reason', 'recovery']) ||
    typeof rejection.code !== 'string' ||
    !REJECTION_CODES.has(rejection.code) ||
    !boundedText(rejection.reason, 512) ||
    !rejection.recovery ||
    typeof rejection.recovery !== 'object' ||
    Array.isArray(rejection.recovery)
  ) {
    return false;
  }
  const recovery = rejection.recovery as Record<string, unknown>;
  return (
    exactFields(recovery, ['kind', 'instruction']) &&
    typeof recovery.kind === 'string' &&
    ['repair-manifest', 'restore-manifest', 'reinstall-plugin'].includes(
      recovery.kind,
    ) &&
    boundedText(recovery.instruction, 512)
  );
}

export interface PluginCollectionFailure {
  success: false;
  error: string;
  /**
   * The envelope's machine `code`, when it sent one — a station-control
   * authority refusal (#2377) such as `station_control_caller_required`.
   * `list_plugins` relays this envelope whole, so without it an agent got the
   * refusal's words and not the code it branches on (#2708).
   */
  code?: string;
  grantsUnavailable?: true;
}

/**
 * The plugin collection read failed. A `StationHttpError` (#2708), so a caller
 * branching on status or `code` treats it like every other refused request;
 * `envelope` is the failure as `list_plugins` relays it.
 */
export class PluginCollectionHttpError extends StationHttpError {
  readonly envelope: PluginCollectionFailure;

  constructor(status: number, envelope: PluginCollectionFailure) {
    super(
      status,
      envelope.error,
      envelope.code === undefined ? undefined : { code: envelope.code },
    );
    this.name = 'PluginCollectionHttpError';
    this.envelope = envelope;
  }
}

/** Canonical `GET /api/plugins` collection read shared by SDK, UI, CLI, and MCP. */
export async function listPlugins(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<InstalledPluginRecord[]> {
  const response = await getJson(`${apiBase}/api/plugins`, opts);
  const result = (await response.json()) as {
    success?: unknown;
    plugins?: unknown;
    error?: unknown;
    grantsUnavailable?: unknown;
  };
  const code = envelopeErrorCode(result);
  if (!response.ok) {
    throw new PluginCollectionHttpError(response.status, {
      success: false,
      error:
        typeof result.error === 'string' && result.error.length > 0
          ? result.error
          : `Plugin request failed with HTTP ${response.status}`,
      ...(code === undefined ? {} : { code }),
      ...(result.grantsUnavailable === true
        ? { grantsUnavailable: true as const }
        : {}),
    });
  }
  if (result.success === false) {
    throw new PluginCollectionHttpError(200, {
      success: false,
      error:
        typeof result.error === 'string' && result.error.length > 0
          ? result.error
          : 'Plugin collection request was rejected',
      ...(code === undefined ? {} : { code }),
    });
  }
  if (
    !Array.isArray(result.plugins) ||
    result.plugins.some((plugin) => {
      if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
        return true;
      }
      const record = plugin as Record<string, unknown>;
      if (record.status === 'rejected') {
        return !isRejectedInstalledPlugin(record);
      }
      if ('status' in record) return true;
      return (
        typeof record.name !== 'string' ||
        typeof record.version !== 'string' ||
        (record.installationReadiness !== undefined &&
          !isPluginInstallationReadiness(record.installationReadiness)) ||
        (record.retainedOnRemoval !== undefined &&
          typeof record.retainedOnRemoval !== 'boolean')
      );
    })
  ) {
    throw new Error('Plugin collection response is malformed');
  }
  return result.plugins as InstalledPluginRecord[];
}

/**
 * The operator's pre-install decision (station#4288), taken from the preview
 * the operator actually read. `contentDigest` is what makes it a decision
 * about BYTES rather than about a name: the server re-derives it from its own
 * staged copy and refuses — before writing anything — if the two differ.
 */
export interface PluginInstallConsent {
  grantRevision?: string;
  registryTrustRevision?: string;
  permissions: string[];
  contentDigest: string;
  dependencies: string[];
  dependencyApprovals?: Array<{
    id: string;
    grantRevision?: string;
    registryTrustRevision?: string;
    permissions: string[];
    contentDigest: string;
    dependencies: string[];
  }>;
}

export type PluginRecoveryConsent = Omit<
  PluginInstallConsent,
  'grantRevision' | 'dependencyApprovals'
> & {
  grantRevision: string;
  registryTrustRevision?: string;
  dependencyApprovals?: Array<
    NonNullable<PluginInstallConsent['dependencyApprovals']>[number] & {
      grantRevision: string;
      registryTrustRevision?: string;
    }
  >;
};
export interface PluginRecoveryInput {
  recoveryRevision: string;
  consent: PluginRecoveryConsent;
}
export interface PluginRecoveryPreview {
  manifest: PluginManifest;
  expectedInstallation: PluginInstallationRevision;
  recoveryRevision: string;
  contentDigest: string;
  grantRevision: string;
  registryTrustRevision?: string;
  permissions: {
    required: string[];
    autoGranted: string[];
    pendingConsent: PluginPermissionPrompt[];
  };
  dependencies: Array<{
    id: string;
    expectedInstallation: PluginInstallationRevision;
    consent: {
      contentDigest: string;
      permissions: string[];
      dependencies: string[];
      grantRevision: string;
      registryTrustRevision?: string;
    };
  }>;
  skip: string[];
}
export type PluginRecoveryResult = PluginInstallResult & {
  /** Acceptance-time receipt, not a live activation subscription. */
  configurationActivation?: { status: 'applied' | 'pending'; reason?: string };
};

export async function previewPluginRecovery(
  apiBase: string,
  name: string,
  opts?: ClientRequestOptions,
): Promise<PluginRecoveryPreview> {
  const response = await getJson(
    `${apiBase}/api/plugins/${encodeURIComponent(name)}/recovery-preview`,
    opts,
  );
  const result: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      envelopeErrorMessage(result, 'Could not preview plugin recovery'),
    );
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('Plugin recovery preview response is malformed');
  if ('success' in result && result.success === false)
    throw new Error(
      envelopeErrorMessage(result, 'Could not preview plugin recovery'),
    );
  return result as PluginRecoveryPreview;
}

export async function recoverPlugin(
  apiBase: string,
  name: string,
  input: PluginRecoveryInput,
  opts?: ClientRequestOptions,
): Promise<PluginRecoveryResult> {
  const response = await mutateJson(
    `${apiBase}/api/plugins/${encodeURIComponent(name)}/recover`,
    'POST',
    opts,
    {
      recoveryRevision: input.recoveryRevision,
      consent: input.consent,
    },
  );
  const result = (await response.json()) as PluginRecoveryResult;
  // The server uses 202 + success:false for persisted work awaiting activation.
  if (
    !response.ok ||
    (!result.success &&
      !(
        response.status === 202 &&
        result.configurationActivation?.status === 'pending'
      ))
  ) {
    throw new Error(envelopeErrorMessage(result, 'Could not recover plugin'));
  }
  return result;
}
