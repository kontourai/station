/**
 * Terminal history retention settings (#3994): what the five
 * `terminalHistory*` app settings resolve to. The registry refuses each value
 * outside its own range; this owns the rules that span settings.
 */
import { isAbsolute, join, normalize } from 'node:path';
import type { AppConfig } from '@kontourai/station-contracts/config';

const MIB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TerminalRetention {
  /** False: new terminals keep only their in-memory tail. */
  persist: boolean;
  /** Absolute directory holding one journal directory per terminal. */
  directory: string;
  maxAgeMs: number;
  maxTerminalBytes: number;
  maxTotalBytes: number;
}

type RetentionConfig = Pick<
  AppConfig,
  | 'terminalHistoryEnabled'
  | 'terminalHistoryDirectory'
  | 'terminalHistoryMaxAgeDays'
  | 'terminalHistoryMaxTerminalMiB'
  | 'terminalHistoryMaxTotalMiB'
>;

export const TERMINAL_RETENTION_KEYS = [
  'terminalHistoryEnabled',
  'terminalHistoryDirectory',
  'terminalHistoryMaxAgeDays',
  'terminalHistoryMaxTerminalMiB',
  'terminalHistoryMaxTotalMiB',
] as const satisfies readonly (keyof RetentionConfig)[];

export function defaultTerminalJournalDirectory(home: string): string {
  return join(home, 'terminal-journals');
}

/** The refusal for settings that cannot hold together, or null. */
export function terminalRetentionProblem(
  config: Partial<RetentionConfig>,
): string | null {
  const directory = config.terminalHistoryDirectory?.trim();
  if (directory && !isAbsolute(directory))
    return 'terminalHistoryDirectory: expected an absolute path';
  const terminal = config.terminalHistoryMaxTerminalMiB ?? 16;
  const total = config.terminalHistoryMaxTotalMiB ?? 1024;
  if (total < terminal)
    return `terminalHistoryMaxTotalMiB: expected at least the per-terminal size (${terminal} MiB)`;
  return null;
}

/** Resolves stored settings; refuses a combination that cannot hold. */
export function resolveTerminalRetention(
  config: Partial<RetentionConfig>,
  home: string,
): TerminalRetention {
  const problem = terminalRetentionProblem(config);
  if (problem) throw new Error(problem);
  const directory = config.terminalHistoryDirectory?.trim();
  return {
    persist: config.terminalHistoryEnabled ?? true,
    directory: directory
      ? normalize(directory)
      : defaultTerminalJournalDirectory(home),
    maxAgeMs: (config.terminalHistoryMaxAgeDays ?? 30) * DAY_MS,
    maxTerminalBytes: (config.terminalHistoryMaxTerminalMiB ?? 16) * MIB,
    maxTotalBytes: (config.terminalHistoryMaxTotalMiB ?? 1024) * MIB,
  };
}
