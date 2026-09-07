import {
  AGENT_PLUGIN_MANIFEST_SCHEMA_1_0,
  type AgentPluginManifestV1,
  STATION_AGENT_PLUGIN_EXTENSION_ID,
  type StationAgentPluginExtensionV1,
} from '@kontourai/station-contracts/agent-plugin';
import {
  type SchemaValidator,
  validateManifest,
  validateStationExtension,
} from './agent-plugin-validators.generated.mjs';

export interface AgentPluginManifestReport {
  level: 'warning' | 'error';
  code:
    | 'manifest-invalid'
    | 'station-extension-invalid'
    | 'unknown-manifest-field';
  component?: string;
  message: string;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isReservedObjectKey(key: string): boolean {
  return ['__proto__', 'constructor', 'prototype'].includes(key);
}
const CORE_MANIFEST_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
]);
const RETIRED_STATION_ROOT_FIELDS = new Set(['layout', 'layouts']);

/** Manifest-only validation: no home, materialization, data provisioning, imports or network.
 * Unknown client namespaces remain opaque. The Station namespace is independently validated. */
export function parseAgentPluginManifest(
  value: unknown,
  report: (value: AgentPluginManifestReport) => void = () => {},
  validators: {
    manifest: SchemaValidator;
    stationExtension: SchemaValidator;
  } = {
    manifest: validateManifest,
    stationExtension: validateStationExtension,
  },
): {
  manifest: AgentPluginManifestV1;
  stationExtension?: StationAgentPluginExtensionV1;
} | null {
  const manifestError = (message: string) =>
    report({
      level: 'error',
      code: 'manifest-invalid',
      component: 'plugin.json',
      message,
    });
  if (!isRecord(value)) {
    manifestError('Plugin manifest must be an object');
    return null;
  }
  if (value.$schema !== AGENT_PLUGIN_MANIFEST_SCHEMA_1_0) {
    manifestError('Plugin manifest has a missing or unsupported $schema');
    return null;
  }
  for (const retired of RETIRED_STATION_ROOT_FIELDS) {
    if (Object.hasOwn(value, retired)) {
      manifestError(
        `Plugin manifest uses retired Station root field '${retired}'`,
      );
      return null;
    }
  }

  const core: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!CORE_MANIFEST_FIELDS.has(key)) {
      report({
        level: 'warning',
        code: 'unknown-manifest-field',
        component: 'plugin.json',
        message: `Unknown plugin manifest field '${key}' was ignored`,
      });
    } else if (key !== 'extensions') {
      core[key] = fieldValue;
    }
  }
  if (isRecord(value.extensions)) {
    const invalidNamespace = Object.entries(value.extensions).find(
      ([, namespaceValue]) => !isRecord(namespaceValue),
    );
    if (invalidNamespace) {
      manifestError(
        `Plugin manifest extension '${invalidNamespace[0]}' must be an object`,
      );
      return null;
    }
    // The portable schema validates only that namespace values are objects.
    // Empty placeholders prove that shape without inspecting unknown client
    // namespaces or assigning semantics to their contents.
    core.extensions = Object.fromEntries(
      Object.keys(value.extensions).map((namespace) => [namespace, {}]),
    );
  }
  if (!validators.manifest(core)) {
    manifestError(
      `Plugin manifest does not satisfy Agent Plugins 1.0: ${validators.manifest.errors?.[0]?.instancePath || 'root'}`,
    );
    return null;
  }
  if (isReservedObjectKey(core.name as string)) {
    manifestError(
      'Plugin manifest name is temporarily unsupported by Station object-key stores',
    );
    return null;
  }

  let stationExtension: StationAgentPluginExtensionV1 | undefined;
  if (value.extensions !== undefined && !isRecord(value.extensions)) {
    report({
      level: 'warning',
      code: 'manifest-invalid',
      component: 'plugin.json#extensions',
      message: 'Non-object extensions field was ignored',
    });
  } else if (isRecord(value.extensions)) {
    const station = value.extensions[STATION_AGENT_PLUGIN_EXTENSION_ID];
    if (station !== undefined) {
      if (!validators.stationExtension(station)) {
        report({
          level: 'warning',
          code: 'station-extension-invalid',
          component: `plugin.json#extensions.${STATION_AGENT_PLUGIN_EXTENSION_ID}`,
          message: 'Invalid Station extension was disabled',
        });
      } else {
        stationExtension = station as StationAgentPluginExtensionV1;
      }
    }
  }

  const portableManifest = { ...core };
  delete portableManifest.extensions;
  return {
    // Extension namespaces are not portable manifest authority. The one
    // implemented namespace is returned separately only after validation;
    // all others stay deliberately opaque and unprojected.
    manifest: portableManifest as unknown as AgentPluginManifestV1,
    ...(stationExtension ? { stationExtension } : {}),
  };
}
