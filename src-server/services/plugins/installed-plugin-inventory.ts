import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PluginManifest,
  PluginManifestRejection,
  RejectedInstalledPluginRecord,
} from '@kontourai/station-contracts/plugin';
import { sanitizeFreeText } from '@kontourai/station-shared/redaction';
import type { Logger } from '../../utils/logger.js';
import { readPluginManifestFileSync } from './plugin-manifest-loader.js';

const PUBLIC_REASON_MAX = 512;

function rejection(
  code: PluginManifestRejection['code'],
  reason: string,
  recovery: PluginManifestRejection['recovery'],
): PluginManifestRejection {
  const publicReason = sanitizeFreeText(reason, PUBLIC_REASON_MAX).trim();
  return {
    code,
    reason: publicReason || 'Plugin manifest is invalid.',
    recovery,
  };
}

export function describePluginManifestRejection(
  error: unknown,
): PluginManifestRejection {
  const message = error instanceof Error ? error.message : String(error);
  if (
    error instanceof SyntaxError ||
    /JSON|Unexpected token|unterminated/i.test(message)
  ) {
    return rejection('malformed-json', 'plugin.json contains malformed JSON.', {
      kind: 'repair-manifest',
      instruction:
        'Repair plugin.json so it is valid JSON, then choose Reload plugins.',
    });
  }
  if (/unsafe|hidden|control character/i.test(message)) {
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
  if (/name .*not a canonical plugin id/i.test(message)) {
    return rejection('invalid-plugin-name', message, {
      kind: 'repair-manifest',
      instruction:
        'Use a lowercase plugin name containing only letters, digits, and hyphens, then choose Reload plugins.',
    });
  }
  if (/name .*reserved object key/i.test(message)) {
    return rejection('reserved-plugin-name', message, {
      kind: 'repair-manifest',
      instruction:
        'Choose a non-reserved plugin name in plugin.json, then choose Reload plugins.',
    });
  }
  if (/version must be a non-empty string/i.test(message)) {
    return rejection('missing-version', message, {
      kind: 'repair-manifest',
      instruction:
        'Add a non-empty version to plugin.json, then choose Reload plugins.',
    });
  }
  if (/workspacePanes/i.test(message)) {
    return rejection('invalid-workspace-panes', message, {
      kind: 'repair-manifest',
      instruction:
        'Repair the named workspacePanes declaration, then choose Reload plugins.',
    });
  }
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
  return rejection(
    'invalid-manifest',
    message || 'Plugin manifest is invalid.',
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
  const displayName = sanitizeFreeText(entry.directoryName, 255).trim();
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
