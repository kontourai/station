import type {
  PluginInstallationReadiness,
  PluginInstallationRevision,
  PluginInstallResult,
  PluginManifest,
  PluginPermissionPrompt,
  RejectedInstalledPluginRecord,
} from '@kontourai/station-contracts/plugin';
import { envelopeError } from './api-error-message';
import {
  type ClientRequestOptions,
  getJson,
  mutateJson,
  StationHttpError,
} from './http';
import { rethrowDeadline } from './request-deadline';

export type InstalledPluginRecord =
  | (PluginManifest & {
      hasBundle?: boolean;
      retainedOnRemoval?: boolean;
      installationReadiness?: PluginInstallationReadiness;
      /**
       * Opaque generation a plugin command request echoes back. Present, with
       * `commands`, only while the installation is ready; it is not authority.
       */
      installationGeneration?: string;
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
 *
 * Built from the `StationHttpError` the envelope helper made of the response
 * (#2708 A-2), so it keeps that error's status, message, `code`, `details`
 * and `Retry-After` — a rate-limited collection read says when to come back.
 */
export class PluginCollectionHttpError extends StationHttpError {
  readonly envelope: PluginCollectionFailure;

  constructor(
    failure: StationHttpError,
    options?: { grantsUnavailable?: boolean },
  ) {
    super(failure.status, failure.message, failure);
    this.name = 'PluginCollectionHttpError';
    this.envelope = {
      success: false,
      error: failure.message,
      ...(failure.code === undefined ? {} : { code: failure.code }),
      ...(options?.grantsUnavailable === true
        ? { grantsUnavailable: true as const }
        : {}),
    };
  }
}

/** Canonical `GET /api/plugins` collection read shared by SDK, UI, CLI, and MCP. */
export async function listPlugins(
  apiBase: string,
  opts?: ClientRequestOptions,
): Promise<InstalledPluginRecord[]> {
  const response = await getJson(`${apiBase}/api/plugins`, opts);
  const failed = `Plugin request failed with HTTP ${response.status}`;
  let result: {
    success?: unknown;
    plugins?: unknown;
    grantsUnavailable?: unknown;
  };
  try {
    result = (await response.json()) as typeof result;
  } catch (error) {
    rethrowDeadline(error);
    // Unreadable, but answered: a failure keeps its status (#2708). An
    // unreadable 2xx is a protocol failure and rethrows the parse error.
    if (!response.ok)
      throw new PluginCollectionHttpError(
        envelopeError(response, undefined, failed),
      );
    throw error;
  }
  if (!response.ok) {
    throw new PluginCollectionHttpError(
      envelopeError(response, result, failed),
      {
        grantsUnavailable: result.grantsUnavailable === true,
      },
    );
  }
  if (result.success === false) {
    throw new PluginCollectionHttpError(
      envelopeError(response, result, 'Plugin collection request was rejected'),
    );
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
          typeof record.retainedOnRemoval !== 'boolean') ||
        (record.installationGeneration !== undefined &&
          !boundedText(record.installationGeneration, 1024)) ||
        (record.commands !== undefined && !Array.isArray(record.commands))
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
  /**
   * Echo of the preview's `gitMetadata`: the preview staged the source
   * without its git metadata, and the install must stage it the same way.
   */
  gitMetadata?: 'excluded';
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
  const refused = 'Could not preview plugin recovery';
  let result: unknown;
  try {
    result = await response.json();
  } catch (error) {
    rethrowDeadline(error);
    if (!response.ok) throw envelopeError(response, undefined, refused);
    throw error;
  }
  if (!response.ok) throw envelopeError(response, result, refused);
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('Plugin recovery preview response is malformed');
  if ('success' in result && result.success === false)
    throw envelopeError(response, result, refused);
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
  const refused = 'Could not recover plugin';
  let result: PluginRecoveryResult;
  try {
    result = (await response.json()) as PluginRecoveryResult;
  } catch (error) {
    rethrowDeadline(error);
    if (!response.ok) throw envelopeError(response, undefined, refused);
    throw error;
  }
  // The server uses 202 + success:false for persisted work awaiting activation.
  if (
    !response.ok ||
    (!result.success &&
      !(
        response.status === 202 &&
        result.configurationActivation?.status === 'pending'
      ))
  ) {
    throw envelopeError(response, result, refused);
  }
  return result;
}
