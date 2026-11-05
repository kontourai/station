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

/**
 * Reuse canonical Git/session ownership verification; metadata alone is
 * insufficient. The owner is the Session that provisioned the worktree
 * (`ownerThreadId`) or, #4507, the Task that owns it (`ownerTaskId`); the
 * caller establishes which Task a Session belongs to from server-owned
 * state, never from the metadata itself.
 */
export async function captureExecutionWorkspaceBinding(
  input: {
    threadId: string;
    projectSlug: string;
    cwd: string;
    worktree: WorktreeSessionMetadata;
  } & (
    | { ownerThreadId: string; ownerTaskId?: never }
    | { ownerTaskId: string; ownerThreadId?: never }
  ),
): Promise<ExecutionWorkspaceBinding> {
  try {
    if (
      !input.threadId ||
      !(input.ownerThreadId || input.ownerTaskId) ||
      !input.projectSlug ||
      input.cwd !== input.worktree.path
    )
      throw new Error('Invalid workspace binding');
    if (input.ownerTaskId)
      await verifier.assertTaskWorkspace(input.worktree, input.ownerTaskId);
    else
      await verifier.assertSessionWorkspace(
        input.worktree,
        input.ownerThreadId!,
      );
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
  if (binding === undefined) return undefined;
  const coordinate =
    binding !== null && typeof binding === 'object'
      ? bindings.get(binding)
      : undefined;
  if (!coordinate)
    throw new Error('The owned conversation worktree binding is unavailable.');
  return coordinate;
}
