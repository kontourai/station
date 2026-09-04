import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PluginManifest,
  PluginManifestRejection,
  RejectedInstalledPluginRecord,
} from '@kontourai/station-contracts/plugin';
import { sanitizeFreeText } from '@kontourai/station-shared/redaction';
import type { Logger } from '../../utils/logger.js';
import { ContextSafetyError } from '../orchestration/context-safety.js';
import {
  PluginManifestValidationError,
  readPluginManifestFileSync,
} from './plugin-manifest-loader.js';

const PUBLIC_REASON_MAX = 512;

function isUnsafePublicCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

function safePublicText(value: string, maximum: number): string {
  return Array.from(sanitizeFreeText(value, maximum), (character) =>
    isUnsafePublicCharacter(character) ? '\uFFFD' : character,
  )
    .join('')
    .trim();
}

function rejection(
  code: PluginManifestRejection['code'],
  reason: string,
  recovery: PluginManifestRejection['recovery'],
): PluginManifestRejection {
  const publicReason = safePublicText(reason, PUBLIC_REASON_MAX);
  return {
    code,
    reason: publicReason || 'Plugin manifest is invalid.',
    recovery,
  };
}

export function describePluginManifestRejection(
  error: unknown,
): PluginManifestRejection {
  // Filesystem diagnostics commonly include the `plugin.json` path. Classify
  // their stable error code before looking for JSON-related words in the
  // message, or an EACCES/EPERM read failure becomes a malformed-JSON claim.
  const filesystemCode =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
  if (/^E[A-Z0-9]+$/.test(filesystemCode)) {
    return rejection(
      'manifest-unreadable',
      'plugin.json exists but could not be read as a regular manifest file.',
      {
        kind: 'restore-manifest',
        instruction:
          'Restore readable plugin.json permissions or replace the file, then choose Reload plugins.',
      },
    );
  }
  // ContextSafetyError includes its `plugin.json` source in the message.
  // Recognize the typed refusal before the broad JSON syntax fallback.
  if (error instanceof ContextSafetyError) {
    return rejection(
      'unsafe-manifest-content',
      'plugin.json contains unsafe hidden or control content.',
      {
        kind: 'repair-manifest',
        instruction:
          'Remove hidden control content from plugin.json, then choose Reload plugins.',
      },
    );
  }
  if (error instanceof SyntaxError) {
    return rejection('malformed-json', 'plugin.json contains malformed JSON.', {
      kind: 'repair-manifest',
      instruction:
        'Repair plugin.json so it is valid JSON, then choose Reload plugins.',
    });
  }
  if (error instanceof PluginManifestValidationError) {
    switch (error.code) {
      case 'invalid-plugin-name':
        return rejection(
          error.code,
          'plugin.json declares a name that is not a canonical plugin id under Agent Plugins 1.0.',
          {
            kind: 'repair-manifest',
            instruction:
              'Use 1–64 lowercase letters, digits, hyphens, or periods with alphanumeric endpoints and no repeated hyphens or periods, then choose Reload plugins.',
          },
        );
      case 'reserved-plugin-name':
        return rejection(
          error.code,
          'plugin.json declares a reserved plugin name.',
          {
            kind: 'repair-manifest',
            instruction:
              'Choose a non-reserved plugin name in plugin.json, then choose Reload plugins.',
          },
        );
      case 'missing-version':
        return rejection(
          error.code,
          'plugin.json does not declare a non-empty version.',
          {
            kind: 'repair-manifest',
            instruction:
              'Add a non-empty version to plugin.json, then choose Reload plugins.',
          },
        );
      case 'invalid-workspace-panes':
        return rejection(
          error.code,
          'plugin.json contains an invalid workspacePanes declaration.',
          {
            kind: 'repair-manifest',
            instruction:
              'Repair the named workspacePanes declaration, then choose Reload plugins.',
          },
        );
      case 'invalid-manifest':
        return rejection(
          error.code,
          "plugin.json does not satisfy Station's plugin manifest contract.",
          {
            kind: 'reinstall-plugin',
            instruction:
              'Repair plugin.json if you maintain this plugin; otherwise remove its folder and reinstall a compatible version, then choose Reload plugins.',
          },
        );
      default: {
        const neverCode: never = error.code;
        return neverCode;
      }
    }
  }
  return rejection(
    'invalid-manifest',
    'plugin.json could not be validated as a Station plugin manifest.',
    {
      kind: 'reinstall-plugin',
      instruction:
        'Repair plugin.json if you maintain this plugin; otherwise remove its folder and reinstall a compatible version, then choose Reload plugins.',
    },
  );
}

export type InstalledPluginInventoryEntry =
  | {
      state: 'valid';
      directoryName: string;
      manifest: PluginManifest;
    }
  | {
      state: 'rejected';
      directoryName: string;
      rejection: PluginManifestRejection;
    };

export function rejectedInstalledPluginRecord(
  entry: Extract<InstalledPluginInventoryEntry, { state: 'rejected' }>,
): RejectedInstalledPluginRecord {
  const displayName = safePublicText(entry.directoryName, 255);
  return {
    status: 'rejected',
    name: entry.directoryName,
    displayName: displayName || 'Rejected plugin folder',
    rejection: entry.rejection,
  };
}

/** Fresh directory-backed inventory; no rejection registry or parallel store. */
export function scanInstalledPluginInventory(
  pluginsDir: string,
  logger?: Pick<Logger, 'warn'>,
): InstalledPluginInventoryEntry[] {
  if (!existsSync(pluginsDir)) return [];
  const inventory: InstalledPluginInventoryEntry[] = [];
  const entries = readdirSync(pluginsDir, { withFileTypes: true }).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const manifestPath = join(pluginsDir, entry.name, 'plugin.json');
    if (!existsSync(manifestPath)) {
      const missing = rejection(
        'manifest-missing',
        'The installed plugin folder does not contain plugin.json.',
        {
          kind: 'restore-manifest',
          instruction:
            'Restore plugin.json or remove the incomplete folder, then choose Reload plugins.',
        },
      );
      inventory.push({
        state: 'rejected',
        directoryName: entry.name,
        rejection: missing,
      });
      logger?.warn('Installed plugin manifest rejected', {
        pluginDirectory: entry.name,
        code: missing.code,
        reason: missing.reason,
      });
      continue;
    }
    try {
      inventory.push({
        state: 'valid',
        directoryName: entry.name,
        manifest: readPluginManifestFileSync(manifestPath),
      });
    } catch (error) {
      const rejected = describePluginManifestRejection(error);
      inventory.push({
        state: 'rejected',
        directoryName: entry.name,
        rejection: rejected,
      });
      logger?.warn('Installed plugin manifest rejected', {
        pluginDirectory: entry.name,
        code: rejected.code,
        reason: rejected.reason,
      });
    }
  }
  return inventory;
}
