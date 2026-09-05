import type { WorktreeSessionMetadata } from '@kontourai/station-contracts/workspace-isolation';
import { WorktreeProvisioningService } from '../projects/worktree-provisioning-service.js';

declare const executionWorkspaceBrand: unique symbol;
/** Process-local delivery capability, never persisted workspace truth. */
export type ExecutionWorkspaceBinding = Readonly<{
  [executionWorkspaceBrand]: true;
}>;
type Coordinate = Readonly<{
  threadId: string;
  projectSlug: string;
  cwd: string;
}>;
const bindings = new WeakMap<object, Coordinate>();
const verifier = new WorktreeProvisioningService();

/** Reuse canonical Git/session ownership verification; metadata alone is insufficient. */
export async function captureExecutionWorkspaceBinding(input: {
  threadId: string;
  ownerThreadId: string;
  projectSlug: string;
  cwd: string;
  worktree: WorktreeSessionMetadata;
}): Promise<ExecutionWorkspaceBinding> {
  try {
    if (
      !input.threadId ||
      !input.ownerThreadId ||
      !input.projectSlug ||
      input.cwd !== input.worktree.path
    )
      throw new Error('Invalid workspace binding');
    await verifier.assertSessionWorkspace(input.worktree, input.ownerThreadId);
    const binding = Object.freeze({}) as ExecutionWorkspaceBinding;
    bindings.set(
      binding,
      Object.freeze({
        threadId: input.threadId,
        projectSlug: input.projectSlug,
        cwd: input.cwd,
      }),
    );
    return binding;
  } catch {
    throw new Error('The owned conversation worktree is unavailable.');
  }
}

export function readExecutionWorkspaceBinding(
  binding: unknown,
): Coordinate | undefined {
  return binding !== null && typeof binding === 'object'
    ? bindings.get(binding)
    : undefined;
}
