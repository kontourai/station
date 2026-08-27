import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import type {
  WorkspacePaneHostSplit,
  WorkspacePaneHostTabGroup,
} from '@kontourai/station-contracts/workspace-pane-host';
import { type MouseEvent, useEffect, useRef, useState } from 'react';
import type { WorkspacePaneHostOpenPlacement } from './WorkspacePaneHostOpenContext';
import type { WorkspacePaneHostController } from './workspacePaneHostController';

export type WorkspacePaneHostCatalogRequest = WorkspacePaneHostOpenPlacement;

export type WorkspacePaneHostPopOutAvailability =
  | {
      state: 'supported';
      request(
        instance: WorkspacePaneInstance,
      ): Promise<WorkspacePaneHostPopOutRequestResult>;
    }
  | { state: 'unsupported'; reason: string };

/**
 * The command surface deliberately receives only a bounded outcome. Native
 * command messages may contain host details and never enter React state.
 */
export type WorkspacePaneHostPopOutRequestResult =
  | { status: 'opened' }
  | { status: 'unavailable' }
  | { status: 'failed' };

/** Resolves the current pane occurrence before the command surface enables pop-out. */
export type WorkspacePaneHostPopOut =
  | WorkspacePaneHostPopOutAvailability
  | {
      availability(
        instance: WorkspacePaneInstance,
      ): WorkspacePaneHostPopOutAvailability;
    };

export interface WorkspacePaneHostCommandsProps {
  group: WorkspacePaneHostTabGroup;
  selectedPane: WorkspacePaneInstance;
  paneLabel: string;
  controller: WorkspacePaneHostController;
  /** Persisted group selected by this presented tab; absent when it cannot be resolved. */
  targetGroupId?: string;
  /** A projection can flatten tabs without inventing an unsafe reorder mapping. */
  reorderAllowed?: boolean;
  projectedActionNotice?: string;
  parentSplit?: WorkspacePaneHostSplit;
  onOpenCatalog?(request: WorkspacePaneHostCatalogRequest): void;
  popOut?: WorkspacePaneHostPopOut;
  compact?: boolean;
}

/**
 * Presentation-only command surface. It never creates a pane occurrence or
 * opens a native/browser window: catalog and pop-out owners receive typed
 * requests, while host mutations use the controller's existing reducer seam.
 */
export function WorkspacePaneHostCommands({
  group,
  selectedPane,
  paneLabel,
  controller,
  targetGroupId,
  reorderAllowed = true,
  projectedActionNotice,
  parentSplit,
  onOpenCatalog,
  popOut = {
    state: 'unsupported',
    reason: 'This workspace does not support popping out panes.',
  },
  compact = false,
}: WorkspacePaneHostCommandsProps) {
  const [open, setOpen] = useState(false);
  const [popOutPending, setPopOutPending] = useState(false);
  const [popOutNotice, setPopOutNotice] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  const closeMenu = () => {
    setPopOutNotice(null);
    setOpen(false);
  };
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() =>
        menuRef.current
          ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
          ?.focus(),
      );
    } else if (wasOpenRef.current) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
    wasOpenRef.current = open;
  }, [open]);

  const selectedPopOut =
    'availability' in popOut ? popOut.availability(selectedPane) : popOut;
  const canCatalogTarget = Boolean(targetGroupId);
  const canReorder = reorderAllowed && group.instanceIds.length > 1;
  const selectedIndex = group.instanceIds.indexOf(selectedPane.instanceId);
  const move = (toIndex: number) => {
    controller.reorder(selectedPane.instanceId, toIndex);
    closeMenu();
  };
  const requestCatalog = (request: WorkspacePaneHostCatalogRequest) => {
    onOpenCatalog?.(request);
    closeMenu();
  };
  const requestPopOut = async (event: MouseEvent<HTMLButtonElement>) => {
    if (selectedPopOut.state !== 'supported' || popOutPending) return;
    const initiatingControl = event.currentTarget;
    setPopOutPending(true);
    setPopOutNotice(null);
    let result: WorkspacePaneHostPopOutRequestResult;
    try {
      result = await selectedPopOut.request(selectedPane);
    } catch {
      result = { status: 'failed' };
    } finally {
      setPopOutPending(false);
    }
    if (result.status === 'opened') {
      closeMenu();
      return;
    }
    setPopOutNotice(
      result.status === 'unavailable'
        ? 'Pane pop-out is no longer available in this host.'
        : 'Station could not open this pane in a separate window. Try again.',
    );
    requestAnimationFrame(() => initiatingControl.focus());
  };

  return (
    <div className="workspace-pane-host__commands">
      <button
        ref={triggerRef}
        type="button"
        className="workspace-pane-host__command-trigger"
        aria-label={`Pane actions for ${paneLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {compact ? 'Actions' : 'Pane actions'}
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="workspace-pane-host__command-menu"
          role="menu"
          aria-label={`Actions for ${paneLabel}`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeMenu();
              return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
              return;
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                'button:not(:disabled)',
              ),
            ];
            const current = items.indexOf(
              globalThis.document.activeElement as HTMLButtonElement,
            );
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? items.length - 1
                  : event.key === 'ArrowDown'
                    ? (current + 1 + items.length) % items.length
                    : (current - 1 + items.length) % items.length;
            event.preventDefault();
            items[next]?.focus();
          }}
        >
          <button
            type="button"
            role="menuitem"
            disabled={
              !onOpenCatalog || !controller.canPersist || !canCatalogTarget
            }
            onClick={() => {
              if (!targetGroupId) return;
              requestCatalog({ type: 'add', targetGroupId });
            }}
          >
            Open pane catalog
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={
              !onOpenCatalog || !controller.canPersist || !canCatalogTarget
            }
            onClick={() => {
              if (!targetGroupId) return;
              requestCatalog({
                type: 'split',
                targetGroupId,
                orientation: 'horizontal',
                placement: 'after',
              });
            }}
          >
            Choose pane to split right
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={
              !onOpenCatalog || !controller.canPersist || !canCatalogTarget
            }
            onClick={() => {
              if (!targetGroupId) return;
              requestCatalog({
                type: 'split',
                targetGroupId,
                orientation: 'vertical',
                placement: 'after',
              });
            }}
          >
            Choose pane to split below
          </button>
          {projectedActionNotice ? <p>{projectedActionNotice}</p> : null}
          <button
            type="button"
            role="menuitem"
            disabled={
              !canReorder || !controller.canPersist || selectedIndex === 0
            }
            onClick={() => move(selectedIndex - 1)}
          >
            Move tab left
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={
              !canReorder ||
              !controller.canPersist ||
              selectedIndex === group.instanceIds.length - 1
            }
            onClick={() => move(selectedIndex + 1)}
          >
            Move tab right
          </button>
          {parentSplit ? (
            <button
              type="button"
              role="menuitem"
              disabled={!controller.canPersist}
              onClick={() => {
                controller.collapse(
                  parentSplit.id,
                  parentSplit.collapsed
                    ? undefined
                    : parentSplit.first.type === 'tabs' &&
                        parentSplit.first.id === group.id
                      ? 'second'
                      : 'first',
                );
                closeMenu();
              }}
            >
              {parentSplit.collapsed
                ? 'Restore split'
                : 'Collapse other pane group'}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            disabled={!controller.canPersist}
            onClick={() => {
              controller.maximize(
                controller.state.document.maximizedInstanceId
                  ? undefined
                  : selectedPane.instanceId,
              );
              closeMenu();
            }}
          >
            {controller.state.document.maximizedInstanceId
              ? 'Restore workspace panes'
              : 'Maximize pane'}
          </button>
          <button
            type="button"
            role="menuitem"
            aria-describedby={
              selectedPopOut.state === 'unsupported'
                ? `workspace-pane-popout-${selectedPane.instanceId}`
                : undefined
            }
            disabled={selectedPopOut.state !== 'supported' || popOutPending}
            onClick={requestPopOut}
          >
            Pop out pane
          </button>
          {selectedPopOut.state === 'unsupported' ? (
            <p id={`workspace-pane-popout-${selectedPane.instanceId}`}>
              {selectedPopOut.reason}
            </p>
          ) : null}
          {popOutNotice ? <p role="alert">{popOutNotice}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
