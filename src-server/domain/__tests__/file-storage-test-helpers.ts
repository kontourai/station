import type { ProjectConfig } from '@kontourai/station-contracts/project';
import type { FileStorageAdapter } from '../file-storage-adapter.js';

/** Test setup helper that still crosses the production create/revision seams. */
export async function putProject(
  adapter: FileStorageAdapter,
  project: ProjectConfig,
): Promise<void> {
  try {
    await adapter.projectRevision(project.slug).replace(project);
  } catch (error) {
    if ((error as { code?: string }).code !== 'file_storage_not_found') {
      throw error;
    }
    await adapter.createProject(project);
  }
}
