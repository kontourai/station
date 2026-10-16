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
  const utilities = [
    {
      key: 'schedule',
      label: SCHEDULE.label(),
      icon: destinationIcon('schedule'),
      current: activeDestination?.id === SCHEDULE.id,
      onSelect: () => go(SCHEDULE.route),
    },
    {
      key: 'customize',
      label: 'Customize',
      icon: destinationIcon('plugins'),
      current: false,
      onSelect: () => {
        closeMore();
        setCustomizeOpen(true);
      },
    },
    {
      key: 'settings',
      label: SETTINGS.label(),
      icon: <SettingsGlyph />,
      current: activeDestination?.id === SETTINGS.id,
      onSelect: () => go(SETTINGS.route),
    },
  ];
  const utilityButtons = utilities.map((action) => (
    <button
      key={action.key}
      ref={action.key === 'customize' ? customizeTriggerRef : undefined}
      type="button"
      className={`sidebar__footer-action${action.current ? ' sidebar__footer-action--active' : ''}`}
      aria-current={action.current ? 'page' : undefined}
      aria-label={action.label}
      title={action.label}
      aria-haspopup={action.key === 'customize' ? 'dialog' : undefined}
      data-first-run-anchor={
        action.key === 'customize' ? 'customize' : undefined
      }
      onClick={action.onSelect}
    >
      {action.icon}
      {collapsed && (
        <span className="sidebar__utility-label">{action.label}</span>
      )}
    </button>
  ));
  const controls = (
    <>
      <ProjectSidebarPresenceTray
        onOpenActivity={isMobile ? onAfterNavigate : undefined}
      />
      {collapsed ? (
        <nav className="sidebar__utility-menu" aria-label="Sidebar navigation">
          {utilityButtons}
        </nav>
      ) : (
        <div className="sidebar__footer-actions">{utilityButtons}</div>
      )}
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
            onPointerDown={(event) => {
              if (moreOpen) event.preventDefault();
            }}
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
