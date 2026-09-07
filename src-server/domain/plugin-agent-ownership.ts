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
