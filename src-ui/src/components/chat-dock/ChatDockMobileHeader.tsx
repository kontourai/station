import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import { useId, useRef, useState } from 'react';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import { AgentIcon } from '../icons/AgentIcon';
import { ArrowDownGlyph, MenuGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import { ChatDockMobileConnection } from './ChatDockMobileConnection';
import { ProjectSwitcherOverlay } from './ChatDockProjectContext';

/** Overlay behind a tap — kept out of the entry chunk (see the sheet's note). */
const loadChatDockMobileOverflowSheet = () =>
  import('./ChatDockMobileOverflowSheet').then((module) => ({
    default: module.ChatDockMobileOverflowSheet,
  }));

/**
 * App-level and chat-level actions that no longer have a permanent slot once
 * the mobile chat chrome collapses to one row. Every one of them must stay
 * reachable as a real `button` with an accessible name — the composer design
 * doc's agent-navigability principle (docs/design/chat-composer.md §1) does not
 * exempt controls we chose to fold into an overflow.
 */
export interface ChatDockMobileOverflowActions {
  onOpenConversation: () => void;
  onToggleHistory: () => void;
  onOpenChatSettings: () => void;
  /** Null when the active session has no project to open. */
  onOpenProject: (() => void) | null;
  /**
   * The project `onOpenProject` opens. Rendered beside that item and part of
   * its accessible name (station#3309): the phone bar drops the project LABEL
   * below 481px on the argument that the name is still reachable here, and
   * that argument was false while this item read a bare "Open project".
   */
  openProjectName: string | null;
  onOpenProfile: () => void;
  onOpenAppSettings: () => void;
  /** Plain captured identity; the lazy actions sheet owns the full fallback. */
  sessionInventory?: { sessionId: string; projectId?: string };
  /**
   * Dock-height controls. The header carries one visible expand/collapse
   * toggle (#1052 follow-up — the earlier drag-only direction was reversed on
   * device evidence); Full-height and Restore remain overflow-only, and these
   * named entry points also serve keyboard, screen-reader and agent callers
   * (docs/design/chat-composer.md §1).
   */
  onCollapseDock: () => void;
  onExpandDock: () => void;
  /** Full-screen back to the half snap — the old Restore button's job. */
  onRestoreDock: () => void;
  /** Whether the dock is already full-screen, so only the other action shows. */
  isDockMaximized: boolean;
  /** Full-screen layout placement has no ambient dock geometry to control. */
  dockControls?: boolean;
}

/**
 * The mobile identity row's project-switcher affordance (kontourai/station#793):
 * a distinct, accessible control from the task switcher's own buried eyebrow.
 * `null` when the active chat has no bound project — nothing to switch.
 */
export interface ChatDockMobileProjectSwitcher {
  projectSlug: string;
  projectName: string;
  projects: ProjectMetadata[];
  onOpenProject: (projectSlug: string) => void;
  /** station#4524: switches the dock's project binding directly — no chat creation. */
  onSwitchProject: (projectSlug: string, projectName: string) => void;
}

/**
 * The header's visible dock open/close affordance (#1052 follow-up, owner
 * direction 2026-08-14, reversing the earlier drag-only call): activating the
 * dock must not require a gesture. One button, two meanings — collapsed shows
 * an expand chevron that restores Half; any open state shows a collapse
 * chevron. Fine-grained height (Half vs Full) stays with the drag and the
 * overflow menu's named actions.
 */
export interface ChatDockMobileDockToggle {
  state: 'collapsed' | 'open';
  onExpand: () => void;
  onCollapse: () => void;
}

interface ChatDockMobileHeaderProps {
  /**
   * Render the drawer toggle. False while the app toolbar is still on screen —
   * it owns the drawer then, and two buttons named "Toggle menu" is both an
   * e2e strict-mode failure and an ambiguous target for anyone driving by name.
   */
  showDrawerToggle: boolean;
  sessionTitle: string;
  /**
   * station#3309: who is answering, carried on the phone too. The name is
   * text and yields gracefully; the avatar is a fixed 18px taken out of the
   * same block, so index.css drops the AVATAR — never the name — wherever the
   * bar cannot afford both (below 361px, and below 431px while maximized).
   *
   * What actually pins that: `the maximized phone bar keeps the agent name and
   * chat title legible` in tests/mobile-chat-composer.spec.ts, which measures
   * the eyebrow and title TEXT. The neighbouring 320px containment spec does
   * NOT pin it — it measures this control's box, whose padding floor cannot
   * reach zero even when both strings have been squeezed out of existence.
   *
   * `null` when the dock has no active chat to attribute.
   */
  agentIdentity: { name: string; slug: string; icon?: string } | null;
  /** Current git branch for the session's working directory, when known. */
  branchLabel: string | null;
  /**
   * #3309 review SF-2: this lives in the ⋯ sheet, not the bar. At 320px the
   * bar's non-shrinking 44px slots already exceed the available width in the
   * one configuration that supplies a scope (a maximized dock on a chat
   * route, where the drawer toggle is present too) — and clearing a scope is
   * the only state RESET among otherwise primary actions, so it is the one
   * that belongs behind the overflow.
   */
  projectScope?: { name: string; onClear: () => void };
  /** Null when the active chat has no project to switch away from. */
  projectSwitcher: ChatDockMobileProjectSwitcher | null;
  /** Sessions currently executing a turn. */
  activeCount: number;
  unreadCount: number;
  taskSwitcherTriggerRef: RefObject<HTMLButtonElement | null>;
  activityTriggerRef: RefObject<HTMLButtonElement | null>;
  onOpenTaskSwitcher: () => void;
  onOpenActivity: () => void;
  onToggleSidebar: (trigger: HTMLElement) => void;
  onDragPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onDragClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  /** Null when the placement has no ambient dock geometry (fullscreen pane). */
  dockToggle: ChatDockMobileDockToggle | null;
  /**
   * kontourai/station#3309 (owner sketch): New chat is a primary action, not
   * an overflow item — pinned as an icon at the bar's far right.
   */
  onNewChat: () => void;
  overflow: ChatDockMobileOverflowActions;
}

function ActivityGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

/**
 * Local, not imported from the shared Glyph.tsx catalog: this file is eagerly
 * loaded (ChatDock.tsx imports it directly, no lazy boundary), and the
 * shared catalog's folder icon is otherwise only reachable from lazy-loaded
 * routes/modals — importing it here would pull a fresh icon into the entry
 * chunk against scripts/ui-bundle-budget.mjs's tight ceiling. Mirrors
 * ActivityGlyph above (same file, same reasoning).
 */
function ProjectSwitcherGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 4.5h4l1.3 1.5h5.7v7h-11v-8.5Z" />
    </svg>
  );
}

/** Local for the same entry-chunk reason as ActivityGlyph above. */
function NewChatGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/**
 * The whole mobile chat chrome in one row (owner direction, 2026-07-27).
 *
 * It replaces four stacked bars: the app toolbar (hidden while the dock is
 * full-screen — see `App.tsx`'s `app__main--mobile-dock-fullscreen`), the old
 * dock header's title/Restore/collapse cluster, the old mobile tab-bar
 * action row, and `ChatDockProjectContext`. Layout follows the owner's #3309
 * sketch: the dock-toggle chevron leads the bar, the title carries the ⋯
 * chat-actions trigger where its caret used to sit, and New chat is pinned
 * far right as an icon (out of the overflow).
 *
 * Dock height: the drag gesture on this bar (`onDragPointerDown`) plus the
 * grip above it give fine control, and one visible expand/collapse chevron
 * (`dockToggle`) is the gesture-free path (#1052 follow-up, owner direction
 * 2026-08-14). Maximize/Restore stay overflow-only.
 */
export function ChatDockMobileHeader({
  showDrawerToggle,
  sessionTitle,
  agentIdentity,
  branchLabel,
  projectScope,
  projectSwitcher,
  activeCount,
  unreadCount,
  taskSwitcherTriggerRef,
  activityTriggerRef,
  onOpenTaskSwitcher,
  onOpenActivity,
  onToggleSidebar,
  onDragPointerDown,
  onDragClickCapture,
  dockToggle,
  onNewChat,
  overflow,
}: ChatDockMobileHeaderProps) {
  const [isOverflowOpen, setIsOverflowOpen] = useState(false);
  const closeOverflow = () => setIsOverflowOpen(false);
  const [isSwitcherOpen, setIsSwitcherOpen] = useState(false);
  // The chat title reaches assistive tech as this control's DESCRIPTION, not
  // its name (station#3309 LOW-2). Everything visible in the bar is
  // presentational, so without this an AT user could learn which agent is
  // answering but never which chat is open. It has to be the description
  // rather than the name because a name is what locators and voice control
  // match on, and an arbitrary title in a name collides with the other
  // controls in this bar — descriptions are matched by neither.
  const titleDescriptionId = useId();
  const switcherTriggerRef = useRef<HTMLButtonElement>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const chatActionsTriggerRef = useRef<HTMLButtonElement>(null);

  // The project owns its own visible switcher below, matching desktop's
  // named project badge. Keep the identity eyebrow for supporting branch
  // context instead of repeating the project name in two controls.
  //
  // station#3309: the agent leads that eyebrow. Desktop puts agent → engine →
  // model → title in one row; the phone has room for the agent and the title,
  // so those are the two it keeps, and the branch follows the agent when both
  // are known.
  const eyebrow =
    [agentIdentity?.name, branchLabel].filter(Boolean).join(' · ') || null;

  return (
    // Keeps `chat-dock__header` so state-dependent dock CSS that targets the
    // header bar (e.g. the collapsed bar's safe-area padding) still applies.
    <div
      className={`chat-dock__header chat-dock__mobile-header${
        showDrawerToggle ? ' chat-dock__mobile-header--with-drawer' : ''
      }`}
      onPointerDown={onDragPointerDown}
      onClickCapture={onDragClickCapture}
      data-dock-drag-surface=""
      data-testid="chat-dock-mobile-header"
    >
      {/* #3309 (owner sketch): the dock toggle chevron leads the bar, before
          the title — the first thing on the left is the control that changes
          what the whole bar is attached to. */}
      {dockToggle && (
        <button
          ref={chatActionsTriggerRef}
          type="button"
          className="app-toolbar__icon-btn chat-dock__mobile-header-icon chat-dock__mobile-dock-toggle"
          aria-label={
            dockToggle.state === 'collapsed' ? 'Expand chat' : 'Collapse chat'
          }
          // A tap here must never be read as a drag start — it IS the
          // gesture-free path (#1052 follow-up).
          data-no-dock-drag=""
          onClick={
            dockToggle.state === 'collapsed'
              ? dockToggle.onExpand
              : dockToggle.onCollapse
          }
        >
          <span
            className={`chat-dock__mobile-dock-toggle-glyph${
              dockToggle.state === 'collapsed' ? ' is-collapsed' : ''
            }`}
            aria-hidden="true"
          >
            <ArrowDownGlyph />
          </span>
        </button>
      )}

      {showDrawerToggle && (
        <button
          ref={overflowTriggerRef}
          type="button"
          className="app-toolbar__icon-btn chat-dock__mobile-header-icon"
          aria-label="Toggle menu"
          aria-controls="mobile-navigation"
          data-dock-drag-passthrough=""
          onClick={(event) => onToggleSidebar(event.currentTarget)}
        >
          <span aria-hidden="true">
            <MenuGlyph />
          </span>
        </button>
      )}

      {/* #3309 (owner sketch): the ⋯ chat-actions trigger sits where the
          title's caret used to, directly trailing the title text — the
          "menu-ish icon trailing the title" reading of the sketch. The
          cluster is flexible so the icon hugs the title instead of drifting
          to the right edge. */}
      <div
        className="chat-dock__mobile-identity-cluster"
        data-dock-drag-passthrough=""
      >
        <button
          ref={taskSwitcherTriggerRef}
          type="button"
          className="chat-dock__mobile-identity"
          // The bar is the dock's primary resize gesture on a phone; this block
          // covers most of it, so it must not block the drag. A stationary tap
          // still opens the switcher (see useChatDockVerticalDrag).
          data-dock-drag-passthrough=""
          // Everything visible inside this button is `aria-hidden` (it is
          // presentational chrome, not a name source), so this label is the
          // ONLY agent attribution a screen-reader user gets on a phone — and
          // "Switch task" alone told them nothing about who is answering, on
          // the very issue about surfacing that. Same "action — current value"
          // shape as the project and activity triggers beside it. The action
          // stays the prefix so the control is still findable by it.
          //
          // The AGENT only, deliberately — not the session title. A title is
          // arbitrary generated text, and an accessible name is matched by
          // substring: a chat titled "New chat" made this control answer to
          // the same name as the New chat button beside it. That broke two
          // specs on strict mode, but the specs were the messenger — voice
          // control resolves by accessible name too, so it would have made
          // "click New chat" ambiguous for a real user. Only bounded,
          // curated text belongs in a name other controls are found by.
          //
          // "Bounded and curated" is a judgement, not a guarantee: an agent
          // literally named "New chat" or "Chat actions" reproduces the
          // collision, exactly as the pre-existing `Switch project —
          // ${projectName}` beside it can. The trap is narrowed here, not
          // closed — agent names are authored once and reviewed, chat titles
          // are generated per conversation, which is the whole difference.
          aria-label={
            agentIdentity
              ? `Switch task — ${agentIdentity.name}`
              : 'Switch task'
          }
          // The chat title reaches assistive tech HERE rather than in the name
          // above: a description is not what locators or voice control match
          // on, so an arbitrary title is safe in it. Without this the title
          // renders only inside `aria-hidden` chrome and no AT user could
          // learn which chat is open from this bar.
          aria-describedby={titleDescriptionId}
          onClick={onOpenTaskSwitcher}
        >
          {agentIdentity && (
            <span
              className="chat-dock__mobile-agent-avatar"
              aria-hidden="true"
              data-testid="chat-dock-mobile-agent-avatar"
            >
              <AgentIcon agent={agentIdentity} size={18} />
            </span>
          )}
          <span className="chat-dock__mobile-identity-lines">
            {eyebrow && (
              <span className="chat-dock__mobile-eyebrow" aria-hidden="true">
                {eyebrow}
              </span>
            )}
            <span className="chat-dock__mobile-title" aria-hidden="true">
              <span
                className="chat-dock__mobile-title-text"
                id={titleDescriptionId}
              >
                {sessionTitle}
              </span>
            </span>
          </span>
        </button>
        <button
          type="button"
          className="app-toolbar__icon-btn chat-dock__mobile-header-icon chat-dock__mobile-overflow-trigger"
          aria-haspopup="menu"
          aria-expanded={isOverflowOpen}
          aria-label="Chat actions"
          data-dock-drag-passthrough=""
          onClick={() => setIsOverflowOpen((open) => !open)}
        >
          <span aria-hidden="true">⋯</span>
        </button>
      </div>

      {projectSwitcher && (
        <button
          ref={switcherTriggerRef}
          type="button"
          className="app-toolbar__icon-btn chat-dock__mobile-project-trigger"
          aria-haspopup="dialog"
          aria-expanded={isSwitcherOpen}
          aria-label={`Switch project — ${projectSwitcher.projectName}`}
          data-dock-drag-passthrough=""
          onClick={() => setIsSwitcherOpen(true)}
        >
          <span className="chat-dock__mobile-project-icon" aria-hidden="true">
            <ProjectSwitcherGlyph />
          </span>
          <span className="chat-dock__mobile-project-name">
            {projectSwitcher.projectName}
          </span>
        </button>
      )}
      {projectSwitcher && isSwitcherOpen && (
        <ProjectSwitcherOverlay
          anchorRef={switcherTriggerRef}
          boundProjectSlug={projectSwitcher.projectSlug}
          projects={projectSwitcher.projects}
          onOpenProject={projectSwitcher.onOpenProject}
          onSwitchProject={projectSwitcher.onSwitchProject}
          onClose={() => setIsSwitcherOpen(false)}
        />
      )}

      {/* station#3297 — first in the right cluster, so system state sits in
          one stable place rather than moving as the conditional chat controls
          come and go. Always rendered: an indicator that only appears when
          something is wrong makes its absence the signal, and absence is not
          evidence that anything was checked. */}
      <ChatDockMobileConnection />

      <button
        ref={activityTriggerRef}
        type="button"
        className={`app-toolbar__icon-btn chat-dock__mobile-header-icon chat-dock__mobile-activity${
          activeCount > 0 ? ' is-active' : ''
        }`}
        aria-label={
          activeCount > 0
            ? `Activity — ${activeCount} chat${activeCount === 1 ? '' : 's'} working`
            : 'Activity — active and recent chats'
        }
        data-dock-drag-passthrough=""
        onClick={onOpenActivity}
      >
        <ActivityGlyph />
        {activeCount > 0 && (
          <span className="chat-dock__mobile-activity-count" aria-hidden="true">
            {activeCount}
          </span>
        )}
        {activeCount === 0 && unreadCount > 0 && (
          <span className="chat-dock__mobile-activity-dot" aria-hidden="true" />
        )}
      </button>

      {/* #3309 (owner sketch): New chat pinned far right, out of the
          overflow — starting a chat is the bar's primary action. */}
      <button
        type="button"
        className="app-toolbar__icon-btn chat-dock__mobile-header-icon chat-dock__mobile-new-chat"
        aria-label="New chat"
        data-dock-drag-passthrough=""
        onClick={onNewChat}
      >
        <NewChatGlyph />
      </button>

      {isOverflowOpen && (
        <LazyBoundary
          load={loadChatDockMobileOverflowSheet}
          pending={null}
          componentProps={{
            overflow,
            projectScope,
            returnFocusTarget: chatActionsTriggerRef.current,
            onClose: closeOverflow,
          }}
        />
      )}
    </div>
  );
}
