import { useCallback, useEffect, useRef, useState } from 'react';
import {
  APP_DESTINATION_REGISTRY,
  type DestinationDefinition,
} from '../../app-shell/destination-registry';
import { resolveViewFromPath } from '../../app-shell/routing';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { SettingsGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import './ProjectSidebarFooter.css';
import { destinationIcon } from './nav-items';
import { ProjectSidebarPresenceTray } from './ProjectSidebarPresenceTray';
import { SidebarPopover } from './SidebarPopover';

const loadCustomizeDialog = () =>
  import('./CustomizeDialog').then((module) => ({
    default: module.CustomizeDialog,
  }));

function destination(id: string): DestinationDefinition {
  const entry = APP_DESTINATION_REGISTRY.get(id);
  if (!entry) throw new Error(`${id} destination is not registered`);
  return entry;
}
const SCHEDULE = destination('schedule');
const SETTINGS = destination('settings');

interface ProjectSidebarFooterProps {
  activePath: string;
  navigate: (path: string) => void;
  isMobile: boolean;
  collapsed?: boolean;
  onAfterNavigate?: () => void;
}

export function ProjectSidebarFooter({
  activePath,
  navigate,
  isMobile,
  collapsed = false,
  onAfterNavigate,
}: ProjectSidebarFooterProps) {
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Close the utilities popup when its route or presentation changes.
  useEffect(closeMore, [collapsed, activePath, closeMore]);
  const customizeTriggerRef = useRef<HTMLButtonElement>(null);
  const activeDestination = APP_DESTINATION_REGISTRY.getDestinationForView(
    resolveViewFromPath(activePath),
  );
  const go = (path: string) => {
    closeMore();
    navigate(path);
    if (isMobile) onAfterNavigate?.();
  };
  const controls = (
    <>
      <ProjectSidebarPresenceTray
        onOpenActivity={isMobile ? onAfterNavigate : undefined}
      />
      <div className="sidebar__footer-actions">
        <button
          type="button"
          className={`sidebar__footer-action${activeDestination?.id === SCHEDULE.id ? ' sidebar__footer-action--active' : ''}`}
          aria-current={
            activeDestination?.id === SCHEDULE.id ? 'page' : undefined
          }
          aria-label="Schedule"
          title="Schedule"
          onClick={() => go(SCHEDULE.route)}
        >
          {destinationIcon('schedule')}
          <span className="sidebar__utility-label">Schedule</span>
        </button>
        <button
          ref={customizeTriggerRef}
          type="button"
          className="sidebar__footer-action"
          aria-label="Customize"
          title="Customize"
          aria-haspopup="dialog"
          data-first-run-anchor="customize"
          onClick={() => {
            closeMore();
            setCustomizeOpen(true);
          }}
        >
          {destinationIcon('plugins')}
          <span className="sidebar__utility-label">Customize</span>
        </button>
        <button
          type="button"
          className={`sidebar__footer-action${activeDestination?.id === SETTINGS.id ? ' sidebar__footer-action--active' : ''}`}
          aria-current={
            activeDestination?.id === SETTINGS.id ? 'page' : undefined
          }
          aria-label="Settings"
          title="Settings"
          onClick={() => go(SETTINGS.route)}
        >
          <SettingsGlyph />
          <span className="sidebar__utility-label">Settings</span>
        </button>
      </div>
    </>
  );
  return (
    <div className="sidebar__footer">
      <div className="sidebar__footer-meta">
        {collapsed ? (
          <button
            ref={moreTriggerRef}
            type="button"
            className="sidebar__footer-action"
            aria-label="Sidebar utilities"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            title="Live work, Schedule, Customize and Settings"
            onClick={() => setMoreOpen((value) => !value)}
          >
            <span aria-hidden="true">•••</span>
          </button>
        ) : (
          controls
        )}
      </div>
      <SidebarPopover
        open={collapsed && moreOpen}
        anchorRef={moreTriggerRef}
        label="Sidebar utilities"
        onClose={closeMore}
      >
        <div className="sidebar__footer-popover">{controls}</div>
      </SidebarPopover>
      {customizeOpen && (
        <LazyBoundary
          load={loadCustomizeDialog}
          pending={null}
          shareAcrossMounts
          unavailable={(retry) => (
            <Dialog
              title="Customize"
              closeLabel="Close Customize"
              onClose={() => setCustomizeOpen(false)}
              historyMode="none"
              returnFocusTarget={
                collapsed ? moreTriggerRef.current : customizeTriggerRef.current
              }
              size="sm"
              footer={
                <>
                  <Button onClick={retry}>Retry</Button>
                  <Button
                    variant="secondary"
                    onClick={() => window.location.reload()}
                  >
                    Reload
                  </Button>
                </>
              }
            >
              <p role="alert">Could not load Customize.</p>
            </Dialog>
          )}
          componentProps={{
            returnFocusTarget: collapsed
              ? moreTriggerRef.current
              : customizeTriggerRef.current,
            onClose: () => setCustomizeOpen(false),
            onNavigate: (path: string) => {
              setCustomizeOpen(false);
              go(path);
            },
          }}
        />
      )}
    </div>
  );
}
