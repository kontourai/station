import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import { createContext, useContext } from 'react';

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
  /** False means validation, durable host prepare, or caller state prepare rejected the occurrence. */
  open(
    instance: WorkspacePaneInstance,
    preparation?: WorkspacePaneHostOpenPreparation,
    placement?: WorkspacePaneHostOpenPlacement,
  ): boolean;
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
