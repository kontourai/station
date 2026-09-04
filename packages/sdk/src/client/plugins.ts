import type {
  PluginManifest,
  RejectedInstalledPluginRecord,
} from '@kontourai/station-contracts/plugin';
import { type ClientRequestOptions, getJson } from './http';

export type InstalledPluginRecord =
  | (PluginManifest & { hasBundle?: boolean })
  | RejectedInstalledPluginRecord;

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
  grantsUnavailable?: true;
}

export class PluginCollectionHttpError extends Error {
  readonly status: number;
  readonly envelope: PluginCollectionFailure;

  constructor(status: number, envelope: PluginCollectionFailure) {
    super(envelope.error);
    this.name = 'PluginCollectionHttpError';
    this.status = status;
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
  if (!response.ok) {
    throw new PluginCollectionHttpError(response.status, {
      success: false,
      error:
        typeof result.error === 'string' && result.error.length > 0
          ? result.error
          : `Plugin request failed with HTTP ${response.status}`,
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
      if (Reflect.has(record, 'status')) return true;
      return (
        typeof record.name !== 'string' || typeof record.version !== 'string'
      );
    })
  ) {
    throw new Error('Plugin collection response is malformed');
  }
  return result.plugins as InstalledPluginRecord[];
}
