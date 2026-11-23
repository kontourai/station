import type { ReactNode } from 'react';
import {
  APP_DESTINATION_REGISTRY,
  customizeItemForView,
} from '../../app-shell/destination-registry';
import { resolveViewFromPath } from '../../app-shell/routing';
import { useCustomizeGroups } from '../../views/customize/useCustomizeGroups';
import { UpdatesControl } from '../updates/UpdatesControl';
import { destinationIcon } from './nav-items';
import { ProjectSidebarBoards } from './ProjectSidebarBoards';
import { SidebarAccountControl } from './SidebarAccountControl';
import './ProjectSidebarFooter.css';
import './QuietSidebar.css';

/**
 * The quiet sidebar's parts, behind the `quiet-sidebar` Feature Preview
 * (`docs/design/first-release-navigation.md`, `navigation-06` to
 * `navigation-11`). `ProjectSidebar` keeps the frame, the header, the Home
 * row and the Projects list, and mounts this chunk only while the preview is
 * on, so the sidebar's first paint carries none of it with the preview off.
 */
interface QuietSidebarPartProps {
  part: 'places' | 'apps' | 'footer';
  collapsed: boolean;
  isMobile: boolean;
  navigate: (path: string) => void;
  activePath: string;
  onAfterNavigate?: () => void;
}

function QuietRow({
  label,
  accessibleLabel = label,
  icon,
  current,
  collapsed,
  trailing,
  onSelect,
}: {
  label: string;
  /** The row's name when it says more than its visible label. */
  accessibleLabel?: string;
  icon: ReactNode;
  current: boolean;
  collapsed: boolean;
  trailing?: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`sidebar__project-btn${
        current ? ' sidebar__project-btn--active' : ''
      }`}
      aria-current={current ? 'page' : undefined}
      aria-label={accessibleLabel}
      title={collapsed ? accessibleLabel : undefined}
      onClick={onSelect}
    >
      <span className="sidebar__nav-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="sidebar__project-name">{label}</span>
      {trailing}
    </button>
  );
}

/**
 * Whether any Customize item needs attention: the same per-item dots the
 * Customize list draws (`useCustomizeGroups`), so the sidebar dot and the
 * page that explains it cannot disagree.
 */
function useCustomizeNeedsAttention(): boolean {
  return useCustomizeGroups().some((group) =>
    group.items.some((item) => item.needsAttention),
  );
}

function QuietFooter({
  collapsed,
  isMobile,
  navigate,
  activePath,
  onAfterNavigate,
}: Omit<QuietSidebarPartProps, 'part'>) {
  const view = resolveViewFromPath(activePath);
  const needsAttention = useCustomizeNeedsAttention();
  const go = (path: string) => {
    navigate(path);
    if (isMobile) onAfterNavigate?.();
  };
  const customize = APP_DESTINATION_REGISTRY.get('customize');
  const settings = APP_DESTINATION_REGISTRY.get('settings');
  return (
    <div className="sidebar__footer sidebar__footer--quiet">
      {customize && (
        <QuietRow
          // The dot's meaning joins the name: a dot alone says nothing to
          // assistive technology.
          label={customize.label()}
          accessibleLabel={
            needsAttention
              ? `${customize.label()}, needs attention`
              : customize.label()
          }
          icon={destinationIcon('customize')}
          current={customizeItemForView(view) !== null}
          collapsed={collapsed}
          trailing={
            needsAttention ? (
              <span className="sidebar__quiet-dot" aria-hidden="true" />
            ) : null
          }
          onSelect={() => go(customize.route)}
        />
      )}
      <div className="sidebar__quiet-settings">
        {settings && (
          <QuietRow
            label={settings.label()}
            icon={destinationIcon('settings')}
            current={view.type === 'settings'}
            collapsed={collapsed}
            onSelect={() => go(settings.route)}
          />
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
    </div>
  );
}

export default function QuietSidebarPart({
  part,
  ...props
}: QuietSidebarPartProps) {
  if (part === 'apps') return <ProjectSidebarBoards {...props} quiet />;
  if (part === 'footer') return <QuietFooter {...props} />;
  const automations = APP_DESTINATION_REGISTRY.get('schedule');
  if (!automations) return null;
  const current =
    APP_DESTINATION_REGISTRY.getDestinationForView(
      resolveViewFromPath(props.activePath),
    )?.id === automations.id;
  return (
    <QuietRow
      label={automations.label()}
      icon={destinationIcon('schedule')}
      current={current}
      collapsed={props.collapsed}
      onSelect={() => {
        props.navigate(automations.route);
        if (props.isMobile) props.onAfterNavigate?.();
      }}
    />
  );
}
