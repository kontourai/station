import { useCallback, useEffect, useRef, useState } from 'react';
import {
  APP_DESTINATION_REGISTRY,
  customizeItemForView,
  type DestinationDefinition,
} from '../../app-shell/destination-registry';
import { resolveViewFromPath } from '../../app-shell/routing';
import { UpdatesControl } from '../updates/UpdatesControl';
import './ProjectSidebarFooter.css';
import { destinationIcon } from './nav-items';
import { SidebarAccountControl } from './SidebarAccountControl';
import { SidebarPopover } from './SidebarPopover';

function destination(id: string): DestinationDefinition {
  const entry = APP_DESTINATION_REGISTRY.get(id);
  if (!entry) throw new Error(`${id} destination is not registered`);
  return entry;
}
const SCHEDULE = destination('schedule');
const CUSTOMIZE = destination('customize');

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
  const [moreOpen, setMoreOpen] = useState(false);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Close the utilities popup when its route or presentation changes.
  useEffect(closeMore, [collapsed, activePath, closeMore]);
  const activeView = resolveViewFromPath(activePath);
  const activeDestination =
    APP_DESTINATION_REGISTRY.getDestinationForView(activeView);
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
      // Customize is a page: the button marks it current on the landing and
      // on every item it lists.
      key: 'customize',
      label: CUSTOMIZE.label(),
      icon: destinationIcon('customize'),
      current: customizeItemForView(activeView) !== null,
      onSelect: () => go(CUSTOMIZE.route),
    },
  ];
  const utilityButtons = utilities.map((action) => (
    <button
      key={action.key}
      type="button"
      className={`sidebar__footer-action${action.current ? ' sidebar__footer-action--active' : ''}`}
      aria-current={action.current ? 'page' : undefined}
      aria-label={action.label}
      title={action.label}
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
  const controls = collapsed ? (
    <nav className="sidebar__utility-menu" aria-label="Sidebar navigation">
      {utilityButtons}
    </nav>
  ) : (
    <div className="sidebar__footer-actions">{utilityButtons}</div>
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
            title="Automations and Customize"
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
        <div className="sidebar__footer-identity">
          <div className="sidebar__update">
            <UpdatesControl collapsed onNavigate={go} />
          </div>
          <SidebarAccountControl
            activePath={activePath}
            collapsed={collapsed}
            onNavigate={go}
            onDismissDrawer={isMobile ? onAfterNavigate : undefined}
          />
        </div>
      </div>
      <SidebarPopover
        open={collapsed && moreOpen}
        anchorRef={moreTriggerRef}
        label="Sidebar utilities"
        onClose={closeMore}
      >
        <div className="sidebar__footer-popover">{controls}</div>
      </SidebarPopover>
    </div>
  );
}
