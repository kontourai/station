/**
 * Persisted operator choices for workload memory budgets:
 * `<home>/config/workload-budgets.json`. The environment still overrides
 * each value (`resolveWorkloadMemoryBudget`).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { WorkloadMemorySettings } from './workload-budget.js';

function workloadBudgetSettingsPath(homeDir: string): string {
  return join(homeDir, 'config', 'workload-budgets.json');
}

export type WorkloadSettingsRead =
  | { settings: WorkloadMemorySettings }
  | { settings: WorkloadMemorySettings; error: string };

function parse(value: unknown): WorkloadMemorySettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('must be a JSON object');
  const settings: WorkloadMemorySettings = {};
  for (const key of ['memoryMiB', 'totalMemoryMiB'] as const) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 1)
      throw new Error(`${key} must be a positive whole number of MiB`);
    settings[key] = entry;
  }
  return settings;
}

/**
 * A missing file is "no choice made". An unreadable or malformed file is
 * reported, and the defaults apply until the operator saves again: a broken
 * file must not stop workloads from starting.
 */
export async function readWorkloadBudgetSettings(
  homeDir: string,
): Promise<WorkloadSettingsRead> {
  const path = workloadBudgetSettingsPath(homeDir);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { settings: {} };
    return { settings: {}, error: `${path} is unreadable: ${String(error)}` };
  }
  try {
    return { settings: parse(JSON.parse(text)) };
  } catch (error) {
    return {
      settings: {},
      error: `${path} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Writes the settings atomically. `beforeCommit` runs after the new bytes are
 * on disk under a unique temporary name and before they replace the file; if
 * it throws, the old file stays and the temporary is removed.
 */
export async function writeWorkloadBudgetSettings(
  homeDir: string,
  settings: WorkloadMemorySettings,
  beforeCommit: () => Promise<void> = async () => {},
): Promise<void> {
  const path = workloadBudgetSettingsPath(homeDir);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      mode: 0o600,
    });
    await beforeCommit();
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
