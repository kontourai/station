import type {
  WorkspacePaneInstance,
  WorkspacePaneInstanceId,
} from '@kontourai/station-contracts/workspace-pane';
import type {
  WorkspacePaneHostSplit,
  WorkspacePaneHostTabGroup,
} from '@kontourai/station-contracts/workspace-pane-host';
import { type ReactNode, useEffect, useState } from 'react';
import { nextTabIndex } from '../utils/tab-navigation';
import { WorkspacePaneFrame } from './WorkspacePaneFrame';
import {
  type WorkspacePaneHostCatalogRequest,
  WorkspacePaneHostCommands,
  type WorkspacePaneHostPopOut,
} from './WorkspacePaneHostCommands';
import type { WorkspacePaneHostController } from './workspacePaneHostController';
import {
  workspacePaneHostPanelIdentity,
  workspacePaneHostTabIdentity,
  workspacePaneHostTupleId,
} from './workspacePaneHostIdentity';
import type { WorkspacePaneHostRuntime } from './workspacePaneHostRuntime';

/** @deprecated import `nextTabIndex` from `../utils/tab-navigation` instead. Kept so this file's existing test import keeps working unchanged. */
export const workspacePaneHostTabNextIndex = nextTabIndex;

export interface WorkspacePaneHostTabsProps {
  group: WorkspacePaneHostTabGroup;
  paneById: ReadonlyMap<WorkspacePaneInstanceId, WorkspacePaneInstance>;
  controller: WorkspacePaneHostController;
  paneLabel(pane: WorkspacePaneInstance | undefined): string;
  renderPane(
    instance: WorkspacePaneInstance,
    presentation: WorkspacePaneHostPanePresentation,
  ): ReactNode;
  showClose?: boolean;
  commandTargetGroupId?: string;
  projectedActions?: boolean;
  reorderAllowed?: boolean;
  projectedActionNotice?: string;
  parentSplit?: WorkspacePaneHostSplit;
  onOpenCatalog?(request: WorkspacePaneHostCatalogRequest): void;
  popOut?: WorkspacePaneHostPopOut;
  compact?: boolean;
  runtime?: WorkspacePaneHostRuntime;
}

export interface WorkspacePaneHostPanePresentation {
  displayMode: 'inline' | 'fullscreen';
  availableDisplayModes: readonly ('inline' | 'fullscreen')[];
  requestDisplayMode(mode: 'inline' | 'fullscreen'): boolean;
}

/** Owns tab interaction and its selected pane frame; tree recursion stays outside. */
export function WorkspacePaneHostTabs({
  group,
  paneById,
  controller,
  paneLabel,
  renderPane,
  showClose = true,
  commandTargetGroupId,
  projectedActions = false,
  reorderAllowed,
  projectedActionNotice,
  parentSplit,
  onOpenCatalog,
  popOut,
  compact = false,
  runtime,
}: WorkspacePaneHostTabsProps) {
  const selected = group.selectedInstanceId ?? group.instanceIds[0];
  const selectedPane = paneById.get(selected);
  const retryPane = controller.retry;
  // Keep hydration's first paint strictly active-only. After it is stable,
  // desktop keeps sibling frames mounted so their real lifecycle callbacks can
  // suspend/resume rather than treating a tab switch as a fresh renderer.
  const [retainDesktopFrames, setRetainDesktopFrames] = useState(false);
  useEffect(() => {
    if (!compact) setRetainDesktopFrames(true);
  }, [compact]);
  return (
    <section
      className="workspace-pane-host__group"
      aria-label="Workspace pane group"
    >
      <div
        role="tablist"
        aria-label="Workspace panes"
        aria-owns={group.instanceIds
          .map((instanceId) =>
            workspacePaneHostTabIdentity(group.id, instanceId),
          )
          .join(' ')}
      />
      <div className="workspace-pane-host__tabs">
        {group.instanceIds.map((instanceId, index) => {
          const pane = paneById.get(instanceId);
          const isSelected = instanceId === selected;
          return (
            <div className="workspace-pane-host__tab-item" key={instanceId}>
              <button
                ref={(element) => {
                  const key = workspacePaneHostTupleId(
                    'ref',
                    group.id,
                    instanceId,
                  );
                  if (element) controller.tabRefs.current.set(key, element);
                  else controller.tabRefs.current.delete(key);
                }}
                id={workspacePaneHostTabIdentity(group.id, instanceId)}
                role="tab"
                type="button"
                aria-selected={isSelected}
                aria-controls={workspacePaneHostPanelIdentity(
                  group.id,
                  instanceId,
                )}
                tabIndex={isSelected ? 0 : -1}
                onClick={() => controller.select(instanceId)}
                onKeyDown={(event) => {
                  const nextIndex = workspacePaneHostTabNextIndex(
                    index,
                    group.instanceIds.length,
                    event.key,
                  );
                  if (nextIndex === null) return;
                  event.preventDefault();
                  const next = group.instanceIds[nextIndex];
                  controller.select(next);
                  controller.focusTab(group.id, next);
                }}
              >
                {paneLabel(pane)}
              </button>
              {showClose && group.instanceIds.length > 1 && (
                <button
                  type="button"
                  className="workspace-pane-host__close"
                  aria-label={`Close ${paneLabel(pane)}`}
                  disabled={!controller.canPersist}
                  onClick={() => void controller.close(instanceId)}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
      {selectedPane ? (
        <WorkspacePaneHostCommands
          group={group}
          selectedPane={selectedPane}
          paneLabel={paneLabel(selectedPane)}
          controller={controller}
          targetGroupId={
            projectedActions
              ? commandTargetGroupId
              : (commandTargetGroupId ?? group.id)
          }
          reorderAllowed={reorderAllowed}
          projectedActionNotice={projectedActionNotice}
          parentSplit={parentSplit}
          onOpenCatalog={onOpenCatalog}
          popOut={popOut}
          compact={compact}
        />
      ) : null}
      {selectedPane && controller.state.rendererFailures[selected] && (
        <section
          className="workspace-pane-host__panel"
          aria-label={`${paneLabel(selectedPane)} unavailable`}
        >
          <p>{paneLabel(selectedPane)} could not open.</p>
          <button type="button" onClick={() => void retryPane(selected)}>
            Retry pane
          </button>
        </section>
      )}
      {(compact || !retainDesktopFrames ? [selected] : group.instanceIds).map(
        (instanceId) => {
          const pane = paneById.get(instanceId);
          if (!pane || controller.state.rendererFailures[instanceId])
            return null;
          const isSelected = instanceId === selected;
          return (
            <div
              id={workspacePaneHostPanelIdentity(group.id, instanceId)}
              className="workspace-pane-host__panel"
              key={instanceId}
              role="tabpanel"
              aria-labelledby={workspacePaneHostTabIdentity(
                group.id,
                instanceId,
              )}
              hidden={!isSelected}
            >
              <WorkspacePaneFrame
                instanceId={instanceId}
                paneName={paneLabel(pane)}
                runtime={runtime}
                onFailure={controller.fail}
                onRetry={retryPane}
              >
                {/* Compact retains only the lightweight callback frame. The
                    renderer child itself remains active-only. */}
                {compact && !isSelected
                  ? null
                  : (() => {
                      const displayMode =
                        controller.state.document.maximizedInstanceId ===
                        pane.instanceId
                          ? 'fullscreen'
                          : 'inline';
                      return renderPane(pane, {
                        displayMode,
                        availableDisplayModes: controller.canPersist
                          ? ['inline', 'fullscreen']
                          : [displayMode],
                        requestDisplayMode: (mode) => {
                          if (!controller.canPersist) return false;
                          controller.maximize(
                            mode === 'fullscreen' ? pane.instanceId : undefined,
                          );
                          return true;
                        },
                      });
                    })()}
              </WorkspacePaneFrame>
            </div>
          );
        },
      )}
    </section>
  );
}
