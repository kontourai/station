import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { showChatPageOrDock } from '../../app-shell/chat-placement';
import {
  APP_DESTINATION_REGISTRY,
  customizeItemForView,
} from '../../app-shell/destination-registry';
import { resolveViewFromPath } from '../../app-shell/routing';
import { withShortcutHint } from '../../contexts/KeyboardShortcutsContext';
import { useNavigationActions } from '../../contexts/NavigationContext';
import { useShortcutDisplay } from '../../hooks/useKeyboardShortcut';
import { dispatchNewChatIntent } from '../../lib/newChatIntent';
import { FOCUSABLE_SELECTOR } from '../../utils/focusable';
import { useCustomizeGroups } from '../../views/customize/useCustomizeGroups';
import { NewChatGlyph } from '../icons/Glyph';
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
  part: 'new-chat' | 'places' | 'apps' | 'footer';
  collapsed: boolean;
  isMobile: boolean;
  navigate: (path: string) => void;
  activePath: string;
  onAfterNavigate?: () => void;
  /** Closes the phone drawer without handing focus back to its trigger. */
  onCloseForChat?: () => void;
}

function QuietRow({
  label,
  accessibleLabel = label,
  title,
  icon,
  current,
  collapsed,
  trailing,
  anchor,
  className = '',
  onSelect,
}: {
  label: string;
  /** The row's name when it says more than its visible label. */
  accessibleLabel?: string;
  /** The rail's tooltip, when it says more than the row's name. */
  title?: string;
  icon: ReactNode;
  current: boolean;
  collapsed: boolean;
  trailing?: ReactNode;
  /** The first-run tour's anchor for this row. */
  anchor?: string;
  className?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`sidebar__project-btn${
        current ? ' sidebar__project-btn--active' : ''
      }${className}`}
      aria-current={current ? 'page' : undefined}
      aria-label={accessibleLabel}
      title={collapsed ? (title ?? accessibleLabel) : undefined}
      data-first-run-anchor={anchor}
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
          anchor="customize"
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

/**
 * After the phone drawer closes for New chat, focus is nowhere: the drawer
 * leaves it to the chat. Once the chat dock has drawn, its composer takes it,
 * or its first control when it has no composer. A dock that focuses itself
 * first wins, and the wait gives up after about a second.
 */
function focusChatWhenItOpens() {
  let frames = 0;
  const step = () => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const dock = document.getElementById('chat-dock');
    const target =
      dock?.querySelector<HTMLElement>('textarea') ??
      dock?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    if (target) target.focus();
    else if (++frames < 60) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * New chat: the same request the dock's own New chat makes. With no dock
 * listening, it shows Chat the way the palette's "Open chat dock" does. It is
 * an action, so it is never the current row. Its hint is the dock's shortcut
 * as bound now, and the drawer leaves the hint out.
 */
function QuietNewChat({
  collapsed,
  isMobile,
  onCloseForChat,
}: Omit<QuietSidebarPartProps, 'part'>) {
  const { setDockState } = useNavigationActions();
  const shortcut = useShortcutDisplay('dock.newChat');
  const label = 'New chat';
  const hint = isMobile || shortcut === 'Not set' ? '' : shortcut;
  return (
    <QuietRow
      label={label}
      title={withShortcutHint(label, 'dock.newChat', () => hint)}
      icon={<NewChatGlyph />}
      current={false}
      collapsed={collapsed}
      className=" sidebar__quiet-new-chat"
      trailing={
        hint && !collapsed ? (
          <kbd className="sidebar__quiet-hint">{hint}</kbd>
        ) : null
      }
      onSelect={() => {
        // The drawer closes first, so the chat opens over the page and not
        // under a drawer that is still leaving.
        if (isMobile) flushSync(() => onCloseForChat?.());
        if (!dispatchNewChatIntent({}))
          showChatPageOrDock(() => setDockState(true));
        if (isMobile) focusChatWhenItOpens();
      }}
    />
  );
}

export default function QuietSidebarPart({
  part,
  ...props
}: QuietSidebarPartProps) {
  if (part === 'new-chat') return <QuietNewChat {...props} />;
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
