import { AsyncLocalStorage } from 'node:async_hooks';

/** Location and resource lifetime only; never model or tool permission. */
export interface NativeExecutionWorkspace {
  readonly workspaceRoot: string | undefined;
  onClose(cleanup: () => void): void;
  close(): void;
}

export const INTERNAL_NATIVE_WORKSPACE_HEADER = 'x-station-native-workspace';

export class NativeExecutionWorkspaceUnavailableError extends Error {
  constructor() {
    super('The native execution workspace is unavailable.');
  }
}

const workspaces = new AsyncLocalStorage<NativeExecutionWorkspace>();
export function currentNativeExecutionWorkspace() {
  return workspaces.getStore();
}
export function runWithNativeExecutionWorkspace<T>(
  workspace: NativeExecutionWorkspace,
  operation: () => T,
): T {
  return workspaces.run(workspace, operation);
}

/** Created only from the existing private relay's server-resolved Session cwd. */
export function createNativeExecutionWorkspace(
  workspaceRoot: string | undefined,
): NativeExecutionWorkspace {
  let closed = false;
  const cleanup = new Set<() => void>();
  return Object.freeze({
    get workspaceRoot() {
      if (closed) throw new NativeExecutionWorkspaceUnavailableError();
      return workspaceRoot;
    },
    onClose(dispose: () => void) {
      if (closed) throw new NativeExecutionWorkspaceUnavailableError();
      cleanup.add(dispose);
    },
    close() {
      if (closed) return;
      closed = true;
      const failures: unknown[] = [];
      for (const dispose of cleanup) {
        try {
          dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      cleanup.clear();
      if (failures.length)
        throw new AggregateError(failures, 'Native workspace cleanup failed');
    },
  });
}
