import type { ApiRequestScope } from '@kontourai/station-sdk/client';

export type ProjectRecoveryScope = Pick<
  ApiRequestScope,
  'apiBase' | 'authorityKey'
> & {
  draftRecoveryKey?: string;
};

export function projectCreationRecoveryIdentity(
  scope: ProjectRecoveryScope,
): string {
  return JSON.stringify([
    'project-creation',
    scope.apiBase,
    scope.draftRecoveryKey ?? scope.authorityKey,
  ]);
}

export function readProjectCreationRecovery(
  scope: ProjectRecoveryScope,
): string | null {
  return localStorage.getItem(projectCreationRecoveryIdentity(scope));
}

export function writeProjectCreationRecovery(
  scope: ProjectRecoveryScope,
  serialized: string,
): void {
  localStorage.setItem(projectCreationRecoveryIdentity(scope), serialized);
}

export function removeProjectCreationRecovery(
  scope: ProjectRecoveryScope,
): void {
  localStorage.removeItem(projectCreationRecoveryIdentity(scope));
}

export function documentImportRecoveryIdentity(
  scope: ProjectRecoveryScope,
  projectId: string,
): string {
  return `station.document-import:${JSON.stringify([scope.apiBase, scope.draftRecoveryKey ?? scope.authorityKey, projectId])}`;
}

export function readDocumentImportRecovery(
  scope: ProjectRecoveryScope,
  projectId: string,
): string[] {
  const prefix = documentImportRecoveryIdentity(scope, projectId);
  const entries: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key !== prefix && !key?.startsWith(`${prefix}:`)) continue;
      try {
        const value = localStorage.getItem(key);
        if (value) entries.push(value);
      } catch {
        // A failed read leaves the saved entry available for manual recovery.
      }
    }
  } catch {
    return entries;
  }
  return entries;
}

export function writeDocumentImportRecovery(
  scope: ProjectRecoveryScope,
  projectId: string,
  requestId: string,
  serialized: string,
): void {
  localStorage.setItem(
    `${documentImportRecoveryIdentity(scope, projectId)}:${requestId}`,
    serialized,
  );
}

export function removeDocumentImportRecovery(
  scope: ProjectRecoveryScope,
  projectId: string,
  requestId: string,
): void {
  localStorage.removeItem(
    `${documentImportRecoveryIdentity(scope, projectId)}:${requestId}`,
  );
}

export function readLegacyDocumentImportRecovery(
  scope: ProjectRecoveryScope,
  projectId: string,
): string | null {
  return localStorage.getItem(documentImportRecoveryIdentity(scope, projectId));
}

export function removeLegacyDocumentImportRecovery(
  scope: ProjectRecoveryScope,
  projectId: string,
): void {
  localStorage.removeItem(documentImportRecoveryIdentity(scope, projectId));
}
