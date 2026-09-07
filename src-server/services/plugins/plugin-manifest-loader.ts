import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { validateOperationalEventScopes } from '@kontourai/station-contracts/operational-event';
import {
  isCanonicalPluginId,
  type PluginManifest,
} from '@kontourai/station-contracts/plugin';
import { parseWorkspacePaneDescriptor } from '@kontourai/station-contracts/workspace-pane';
import { isReservedObjectKey } from '../../utils/reserved-object-keys.js';
import { assertSafeContextText } from '../orchestration/context-safety.js';
import { parseWorkspacePaneHostContribution } from './workspace-pane-host-contributions.js';

const SUBSCRIPTION_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const SUBSCRIPTION_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/;
const OPERATIONAL_EVENT_TYPE =
  /^(?:station|(?:plugin|kit)\.[a-z][a-z0-9-]*)\.[a-z][a-z0-9.-]*\/v[1-9][0-9]*$/;
const MAX_PLUGIN_EVENT_SUBSCRIPTIONS = 16;

export type PluginManifestValidationFailureCode =
  | 'invalid-plugin-name'
  | 'reserved-plugin-name'
  | 'missing-version'
  | 'invalid-workspace-panes'
  | 'invalid-manifest';

/**
 * Stable loader authority for public rejection classification. Messages may
 * contain manifest-controlled values and must never be used as classifiers.
 */
export class PluginManifestValidationError extends Error {
  readonly name = 'PluginManifestValidationError';

  constructor(
    readonly code: PluginManifestValidationFailureCode,
    message: string,
  ) {
    super(message);
  }
}

function invalidManifest(
  code: PluginManifestValidationFailureCode,
  message: string,
): never {
  throw new PluginManifestValidationError(code, message);
}

export async function readPluginManifestFile(
  manifestPath: string,
): Promise<PluginManifest> {
  const raw = await readFile(manifestPath, 'utf-8');
  return parsePluginManifest(raw, manifestPath);
}

export function readPluginManifestFileSync(
  manifestPath: string,
): PluginManifest {
  const raw = readFileSync(manifestPath, 'utf-8');
  return parsePluginManifest(raw, manifestPath);
}

export function parsePluginManifest(
  raw: string,
  manifestPath: string,
): PluginManifest {
  assertSafeContextText(raw, {
    profile: 'hidden-only',
    source: `plugin manifest '${dirname(manifestPath)}/${basename(manifestPath)}'`,
  });
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalidManifest('invalid-manifest', 'Plugin manifest must be an object');
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) {
    invalidManifest(
      'invalid-plugin-name',
      'Plugin manifest name must be a non-empty string',
    );
  }
  // archive#4307: `manifest.name` is a STORE KEY, not a display string — the
  // plugin-overrides store, the grants store, the provider resolver and the
  // installed-plugin registry all key off it, and the manifest's own `name`
  // wins over the directory it was installed into. A non-empty-string check
  // let `"name": "__proto__"` reach `overrides[name]`, where the lookup
  // answered `Object.prototype` (truthy, so the initializer was skipped) and
  // the write hit the prototype setter: caller-controlled settings landed on
  // `Object.prototype` and `JSON.stringify` then serialized an object with no
  // such own key, so the route reported success while nothing persisted.
  //
  // Validated here rather than at each store because this is the ONE place
  // every consumer of `manifest.name` goes through, and because a name that
  // is not a canonical plugin id is a defect in the manifest wherever it is
  // read. Two independent axes, because neither covers the other:
  // `isCanonicalPluginId` refuses `__proto__` (underscores fail the pattern)
  // but `constructor` and `prototype` SATISFY it, and the reserved-key set
  // refuses those three but not `../evil` or `Name With Spaces`.
  if (!isCanonicalPluginId(candidate.name)) {
    invalidManifest(
      'invalid-plugin-name',
      `Plugin manifest name '${candidate.name}' is not a canonical plugin id under Agent Plugins 1.0 (1-64 lowercase letters, digits, hyphens or periods; alphanumeric endpoints; no repeated hyphens or periods)`,
    );
  }
  if (isReservedObjectKey(candidate.name)) {
    invalidManifest(
      'reserved-plugin-name',
      `Plugin manifest name '${candidate.name}' is a reserved object key and cannot name a plugin`,
    );
  }
  if (typeof candidate.version !== 'string' || !candidate.version.trim()) {
    invalidManifest(
      'missing-version',
      'Plugin manifest version must be a non-empty string',
    );
  }
  if (candidate.workspacePaneHost !== undefined) {
    const contribution = parseWorkspacePaneHostContribution(
      candidate.workspacePaneHost,
    );
    if (!contribution)
      invalidManifest(
        'invalid-manifest',
        'Invalid Workspace Pane host contribution',
      );
    candidate.workspacePaneHost = contribution;
  }
  // archive#4307 review: a declared setting's `key` is a STORE KEY too — it is
  // written into `overrides[plugin].settings` by `PUT /:name/settings` and
  // read back into the map handed to a plugin server module as
  // `config.get`/`config.all` — and it was never inspected here at all. A
  // manifest declaring `{"key": "__proto__"}` therefore reparented that map on
  // the FIRST loop iteration, with no store write anywhere in the story. The
  // accumulators are null-prototype now, but a store key that names an
  // `Object.prototype` member is a defect in the manifest wherever it is read,
  // so it is refused at the one place every consumer goes through. Only the
  // reserved names are refused: settings keys are camelCase field names
  // (`apiKey`), not canonical ids, so the second axis does not apply here.
  if (Array.isArray(candidate.settings)) {
    candidate.settings.forEach((field, index) => {
      const key = (field as Record<string, unknown> | null)?.key;
      if (typeof key === 'string' && isReservedObjectKey(key)) {
        invalidManifest(
          'invalid-manifest',
          `Plugin manifest settings[${index}].key '${key}' is a reserved object key and cannot name a setting`,
        );
      }
    });
  }
  if (candidate.layout !== undefined) {
    if (
      !candidate.layout ||
      typeof candidate.layout !== 'object' ||
      Array.isArray(candidate.layout)
    ) {
      invalidManifest(
        'invalid-manifest',
        'Plugin manifest layout must be an object',
      );
    }
    const source = (candidate.layout as Record<string, unknown>).source;
    if (source !== undefined && typeof source !== 'string') {
      invalidManifest(
        'invalid-manifest',
        'Plugin layout source must be a string',
      );
    }
  }
  if (candidate.workspacePanes !== undefined) {
    if (!Array.isArray(candidate.workspacePanes)) {
      invalidManifest(
        'invalid-workspace-panes',
        'Plugin workspacePanes must be an array',
      );
    }
    // One manifest, one contribution channel (archive#3543). A manifest
    // combining `workspacePanes` with a legacy `layout`/`layouts` declaration
    // would declare the same surface through two migration channels. The
    // legacy bridge also binds plugin provenance, but its noun is retiring in
    // archive#2713; accepting both channels would make ownership and precedence
    // ambiguous. The check is deliberately one-way: a legacy-only manifest is
    // the archive#2713 retirement path and never reaches it.
    if (candidate.layout !== undefined || candidate.layouts !== undefined) {
      invalidManifest(
        'invalid-workspace-panes',
        'Plugin workspacePanes cannot be combined with legacy layout declarations',
      );
    }
    const ids = new Set<string>();
    candidate.workspacePanes = candidate.workspacePanes.map((pane, index) => {
      if (pane && typeof pane === 'object' && !Array.isArray(pane)) {
        const descriptor = pane as Record<string, unknown>;
        if (Object.hasOwn(descriptor, 'contextRequirement')) {
          invalidManifest(
            'invalid-workspace-panes',
            `Plugin workspacePanes[${index}] uses retired field 'contextRequirement'; write modes: [{ id: 'default', contextRequirement: … }] instead`,
          );
        }
        if (Object.hasOwn(descriptor, 'dockability')) {
          invalidManifest(
            'invalid-workspace-panes',
            `Plugin workspacePanes[${index}] uses retired field 'dockability'; write modes: [{ id: 'default', contextRequirement: … }] instead`,
          );
        }
      }
      const parsed = parseWorkspacePaneDescriptor(pane);
      if (!parsed) {
        invalidManifest(
          'invalid-workspace-panes',
          `Plugin workspacePanes[${index}] is invalid`,
        );
      }
      if (
        parsed.provenance.origin !== 'plugin' ||
        parsed.provenance.pluginId !== candidate.name
      ) {
        invalidManifest(
          'invalid-workspace-panes',
          `Plugin workspacePanes[${index}] provenance must name plugin '${candidate.name}'`,
        );
      }
      if (ids.has(parsed.id)) {
        invalidManifest(
          'invalid-workspace-panes',
          `Plugin workspacePanes contains duplicate id '${parsed.id}'`,
        );
      }
      ids.add(parsed.id);
      return parsed;
    });
  }
  if (candidate.operationalEventSubscriptions !== undefined) {
    if (!Array.isArray(candidate.operationalEventSubscriptions)) {
      invalidManifest(
        'invalid-manifest',
        'Plugin operationalEventSubscriptions must be an array',
      );
    }
    if (
      candidate.operationalEventSubscriptions.length >
      MAX_PLUGIN_EVENT_SUBSCRIPTIONS
    ) {
      invalidManifest(
        'invalid-manifest',
        `Plugin operationalEventSubscriptions may contain at most ${MAX_PLUGIN_EVENT_SUBSCRIPTIONS} entries`,
      );
    }
    if (
      candidate.operationalEventSubscriptions.length > 0 &&
      typeof candidate.serverModule !== 'string'
    ) {
      invalidManifest(
        'invalid-manifest',
        'Plugin operationalEventSubscriptions require a serverModule',
      );
    }
    const ids = new Set<string>();
    candidate.operationalEventSubscriptions =
      candidate.operationalEventSubscriptions.map((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          invalidManifest(
            'invalid-manifest',
            `Plugin operationalEventSubscriptions[${index}] must be an object`,
          );
        }
        const entry = value as Record<string, unknown>;
        const unknown = Object.keys(entry).filter(
          (key) =>
            ![
              'id',
              'version',
              'eventTypes',
              'requiredScopes',
              'projection',
            ].includes(key),
        );
        if (unknown.length > 0) {
          invalidManifest(
            'invalid-manifest',
            `Plugin operationalEventSubscriptions[${index}] contains unknown field '${unknown[0]}'`,
          );
        }
        if (typeof entry.id !== 'string' || !SUBSCRIPTION_ID.test(entry.id)) {
          invalidManifest(
            'invalid-manifest',
            `Plugin operationalEventSubscriptions[${index}].id is invalid`,
          );
        }
        if (ids.has(entry.id)) {
          invalidManifest(
            'invalid-manifest',
            `Plugin operationalEventSubscriptions contains duplicate id '${entry.id}'`,
          );
        }
        ids.add(entry.id);
        if (
          typeof entry.version !== 'string' ||
          !SUBSCRIPTION_VERSION.test(entry.version)
        ) {
          invalidManifest(
            'invalid-manifest',
            `Plugin operationalEventSubscriptions[${index}].version is invalid`,
          );
        }
        if (
          !Array.isArray(entry.eventTypes) ||
          entry.eventTypes.length < 1 ||
          entry.eventTypes.length > 32 ||
          new Set(entry.eventTypes).size !== entry.eventTypes.length ||
          !entry.eventTypes.every(
            (type) =>
              typeof type === 'string' && OPERATIONAL_EVENT_TYPE.test(type),
          )
        ) {
          invalidManifest(
            'invalid-manifest',
            `Plugin operationalEventSubscriptions[${index}].eventTypes is invalid`,
          );
        }
        if (
          entry.projection !== undefined &&
          !['metadata', 'envelope'].includes(entry.projection as string)
        ) {
          invalidManifest(
            'invalid-manifest',
            `Plugin operationalEventSubscriptions[${index}].projection is invalid`,
          );
        }
        const scopes = validateOperationalEventScopes(
          entry.requiredScopes ?? [],
        );
        if (!scopes.ok) {
          invalidManifest(
            'invalid-manifest',
            `Plugin operationalEventSubscriptions[${index}].requiredScopes is invalid`,
          );
        }
        return {
          id: entry.id,
          version: entry.version,
          eventTypes: [...entry.eventTypes],
          requiredScopes: scopes.scopes,
          projection: entry.projection ?? 'metadata',
        };
      });
  }
  return candidate as unknown as PluginManifest;
}
