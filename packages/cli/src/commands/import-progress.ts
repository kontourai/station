import { join } from 'node:path';
import type { PortabilityImportLedgerEntry } from '@kontourai/station-contracts/portability';
import {
  publishJsonFileWithOwnedLock,
  readJsonFile,
} from '@kontourai/station-shared/json-file-storage';

export interface ImportProgress {
  version: 1;
  id: string;
  sourceFormat: PortabilityImportLedgerEntry['sourceFormat'];
  sourcePath: string;
  sourceSha256: string;
  importedAt: string;
  phase: 'applying' | 'publishing' | 'complete';
  effects: Array<{
    target: string;
    status: 'pending' | 'uncertain' | 'applied';
  }>;
}

export function importProgressPath(projectHome: string): string {
  return join(projectHome, 'imports', '.progress', 'state.json');
}

export function completedImportLedgerPath(
  projectHome: string,
  id: string,
): string {
  return join(projectHome, 'imports', `${id}.json`);
}

const missing = Symbol('missing import progress');

export function readImportProgress(projectHome: string): ImportProgress | null {
  const path = importProgressPath(projectHome);
  const value = readJsonFile<ImportProgress | typeof missing>(path, missing);
  if (value === missing) return null;
  if (
    value?.version !== 1 ||
    typeof value.id !== 'string' ||
    !/^(?:agents-md|claude-desktop)-[0-9a-f-]{36}$/.test(value.id) ||
    !['agents-md', 'claude-desktop'].includes(value.sourceFormat) ||
    !value.id.startsWith(`${value.sourceFormat}-`) ||
    typeof value.sourcePath !== 'string' ||
    typeof value.sourceSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.sourceSha256) ||
    typeof value.importedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.importedAt)) ||
    !['applying', 'publishing', 'complete'].includes(value.phase) ||
    !Array.isArray(value.effects) ||
    value.effects.some(
      (effect) =>
        !effect ||
        typeof effect.target !== 'string' ||
        !['pending', 'uncertain', 'applied'].includes(effect.status) ||
        (value.phase !== 'applying' && effect.status !== 'applied'),
    )
  ) {
    throw new Error(`Station import progress is invalid: ${path}`);
  }
  if (value.phase === 'complete') {
    const ledgerPath = completedImportLedgerPath(projectHome, value.id);
    const ledger = readJsonFile<PortabilityImportLedgerEntry | typeof missing>(
      ledgerPath,
      missing,
    );
    if (ledger === missing) return { ...value, phase: 'publishing' };
    if (
      ledger?.id !== value.id ||
      ledger.sourceFormat !== value.sourceFormat ||
      ledger.sourcePath !== value.sourcePath ||
      ledger.importedAt !== value.importedAt
    ) {
      throw new Error(
        `Station import completion ledger does not match its progress: ${ledgerPath}`,
      );
    }
  }
  return value;
}

/** The per-home import mutex holds through this checkpoint and each effect. */
export function writeImportProgress(
  projectHome: string,
  progress: ImportProgress,
): Promise<void> {
  return publishJsonFileWithOwnedLock(
    importProgressPath(projectHome),
    progress,
  );
}
