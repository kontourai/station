import { join } from 'node:path';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import { openPrivateSqlite } from '../../utils/private-sqlite.js';
import { ProjectManifestStore } from './project-manifest-store.js';
import { ProjectMembershipService } from './project-membership-service.js';
import { ProjectMembershipStore } from './project-membership-store.js';

/** Owns membership database lifetime and pins Project reads to the runtime's chosen adapter. */
export function createProjectMembershipRuntime(
  home: string,
  stationId: string,
  storage: IStorageAdapter,
) {
  const db = openPrivateSqlite(
    join(home, 'security', 'project-membership.sqlite'),
    'Project membership',
  );
  try {
    const members = new ProjectMembershipStore(db, stationId);
    const service = new ProjectMembershipService(
      stationId,
      storage,
      new ProjectManifestStore(home, storage),
      members,
    );
    let closed = false;
    return {
      service,
      close() {
        if (closed) return;
        closed = true;
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
