import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRegularFileNoFollow } from './home-schema-gate.js';

/** One ownership marker shared by plugin installation and launch admission. */
export const PLUGIN_AGENT_OWNER_FILE = '.station-plugin-owner.json';

export function pluginAgentOwner(
  agentDir: string,
  maxBytes?: number,
): string | null {
  const marker = join(agentDir, PLUGIN_AGENT_OWNER_FILE);
  if (!existsSync(marker)) return null;
  const stats = lstatSync(marker);
  if (!stats.isFile() || stats.isSymbolicLink()) return null;
  try {
    const parsed = JSON.parse(
      maxBytes === undefined
        ? readFileSync(marker, 'utf-8')
        : readRegularFileNoFollow(agentDir, marker, { maxBytes }),
    ) as {
      plugin?: unknown;
    };
    return typeof parsed.plugin === 'string' ? parsed.plugin : null;
  } catch {
    return null;
  }
}

/** Generation binding used for runtime admission, separate from the historical
 * owner-only test used by resource cleanup. Missing/malformed markers refuse. */
export function pluginAgentInstallationBinding(agentDir: string): {
  plugin: string;
  generation?: string;
} | null {
  try {
    const value: unknown = JSON.parse(
      readRegularFileNoFollow(
        agentDir,
        join(agentDir, PLUGIN_AGENT_OWNER_FILE),
        { maxBytes: 1024 },
      ),
    );
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    const marker = value as { plugin?: unknown; generation?: unknown };
    if (
      typeof marker.plugin !== 'string' ||
      (marker.generation !== undefined &&
        (typeof marker.generation !== 'string' ||
          marker.generation.length > 256))
    )
      return null;
    return {
      plugin: marker.plugin,
      ...(typeof marker.generation === 'string'
        ? { generation: marker.generation }
        : {}),
    };
  } catch {
    return null;
  }
}
