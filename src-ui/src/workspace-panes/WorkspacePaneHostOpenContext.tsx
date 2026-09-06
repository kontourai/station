import type {
  WorkspacePaneInstance,
  WorkspacePaneInstanceId,
} from '@kontourai/station-contracts/workspace-pane';
import { createContext, useContext } from 'react';
import type { WorkspacePaneHostOpenOutcome } from './workspacePaneHostOpenOutcome';

/** A persisted host destination chosen by the command surface before catalog selection. */
export type WorkspacePaneHostOpenPlacement =
  | { type: 'add'; targetGroupId: string }
  | {
      type: 'split';
      targetGroupId: string;
      orientation: 'horizontal' | 'vertical';
      placement: 'after';
    };

/**
 * Provider-neutral host action seam. Callers submit a code-issued Pane
 * instance; the host decides placement, focus, persistence, and lifecycle.
 */
export interface WorkspacePaneHostOpenAction {
  /**
   * A refusal carries the reason the host produced it (#1596), so a caller can
   * say what happened instead of completing a click with nothing on screen.
   * `describeWorkspacePaneOpenRefusal` holds the sentence for each reason.
   */
  open(
    instance: WorkspacePaneInstance,
    preparation?: WorkspacePaneHostOpenPreparation,
    placement?: WorkspacePaneHostOpenPlacement,
  ): WorkspacePaneHostOpenOutcome;
  /**
   * Selects and focuses one already-admitted pane. Unlike `open`, this never
   * writes a second occurrence or falls back when the exact identity is gone.
   */
  focusExisting?(instanceId: WorkspacePaneInstanceId): boolean;
}

/** Caller-owned state transaction paired with the host's durable open. */
export interface WorkspacePaneHostOpenPreparation {
  prepare(): boolean;
  rollback(): void;
}

export const WorkspacePaneHostOpenContext =
  createContext<WorkspacePaneHostOpenAction | null>(null);

export function useWorkspacePaneHostOpenAction(): WorkspacePaneHostOpenAction | null {
  return useContext(WorkspacePaneHostOpenContext);
}
