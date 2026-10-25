import { TaskCaptureBlobStore } from './task-capture-blob-store.js';

/** Reuse storage only while its current home and Project exclusion roots match. */
export function createTaskCaptureBlobStoreFactory(deps: {
  homeDir(): string;
  forbiddenProjectRoots(): readonly string[];
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
}): () => TaskCaptureBlobStore {
  let captureBlobs: { key: string; store: TaskCaptureBlobStore } | undefined;
  return () => {
    const homeDir = deps.homeDir();
    const forbiddenProjectRoots = deps.forbiddenProjectRoots();
    const key = JSON.stringify([homeDir, forbiddenProjectRoots]);
    if (captureBlobs?.key !== key)
      captureBlobs = {
        key,
        store: new TaskCaptureBlobStore({
          homeDir,
          forbiddenProjectRoots,
          logger: deps.logger,
        }),
      };
    return captureBlobs.store;
  };
}
