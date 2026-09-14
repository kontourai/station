import { useAttentionQuery } from '@kontourai/station-sdk';
import {
  APP_DESTINATION_REGISTRY,
  type DestinationDefinition,
} from '../../app-shell/destination-registry';
import { resolveViewFromPath } from '../../app-shell/routing';
import { useApiBase } from '../../contexts/ApiBaseContext';
import {
  formatShortcutChord,
  withShortcutHint,
} from '../../contexts/KeyboardShortcutsContext';
import { useShortcutDisplay } from '../../hooks/useKeyboardShortcut';
import { BellGlyph, PeopleGlyph, SettingsGlyph } from '../icons/Glyph';
import './ProjectSidebarFooter.css';

function destinationOrThrow(id: string): DestinationDefinition {
  const destination = APP_DESTINATION_REGISTRY.get(id);
  if (!destination) throw new Error(`${id} destination is not registered`);
  return destination;
}

const NOTIFICATIONS = destinationOrThrow('notifications');
const SETTINGS = destinationOrThrow('settings');

interface ProjectSidebarFooterProps {
  /** Current route path; drives the current-page mark. */
  activePath: string;
  navigate: (path: string) => void;
  isMobile: boolean;
  onAfterNavigate?: () => void;
}

/**
 * The panel footer (#2059, design record D3): presence, the attention bell,
 * the gear, and the command palette's chord. The chord is the one thing kept
 * from the status line this replaced, and it earns its place: the palette is
 * one of the two ways to reach everything this slice moved out of the panel.
 *
 * Two things the status line carried are gone. The open-chat count and its
 * popover restated the panel's own "Open chats" section (and, on the
 * collapsed rail, its dedicated button) from a second copy of the same store.
 * The build identity is not panel chrome — it is what you quote when
 * reporting a problem, and `ReportProblemDialog` stamps `buildLabel` into
 * every report without anyone having to read it off a rail.
 *
 * Lazy, so its stylesheet and the attention query stay out of the entry chunk
 * the sidebar itself belongs to.
 */
export function ProjectSidebarFooter({
  activePath,
  navigate,
  isMobile,
  onAfterNavigate,
}: ProjectSidebarFooterProps) {
  const commandPaletteShortcut = useShortcutDisplay('command-palette');
  const { apiBase } = useApiBase();
  const { data: attention } = useAttentionQuery(apiBase);
  // The same projection field the header bell reads, through the same
  // `['attention', apiBase]` cache entry and the same registry badge — two
  // bells that disagreed about the number would be two claims about one fact.
  const notificationBadge = NOTIFICATIONS.badge?.({
    attentionCount: attention?.pendingCount ?? 0,
  });
  const notificationLabel = NOTIFICATIONS.label();
  const settingsLabel = SETTINGS.label();
  // Derived the way `ProjectSidebarNav` derives its own current row, not by
  // comparing path strings here: the registry owns which views a destination
  // is the current page for, including the deep ones (`/settings?view=…`).
  const activeDestination = APP_DESTINATION_REGISTRY.getDestinationForView(
    resolveViewFromPath(activePath),
  );

  const go = (path: string) => {
    navigate(path);
    if (isMobile) onAfterNavigate?.();
  };

  return (
    <div className="sidebar__footer">
      <div className="sidebar__footer-meta">
        {/*
          #2066 owns presence. Until it ships there is no presence authority
          to read, so this placeholder reports NOTHING about who is here — no
          count, no avatars, no dot, AND NO ACCESSIBLE NAME. A `role="img"`
          with an aria-label announced "People here" to a screen reader, which
          is a presence claim in the one channel where the qualifying tooltip
          never arrives: an aria-label overrides `title`. A placeholder holding
          a slot needs no name, so it is hidden from the accessibility tree
          entirely until there is something true to say.
        */}
        <span aria-hidden="true" className="sidebar__footer-presence">
          <PeopleGlyph />
        </span>
        <button
          type="button"
          className="sidebar__footer-palette"
          aria-label="Command palette"
          data-first-run-anchor="command-palette"
          title={withShortcutHint(
            'Open command palette',
            'command-palette',
            () => commandPaletteShortcut,
          )}
          onClick={() =>
            window.dispatchEvent(new CustomEvent('open-command-palette'))
          }
        >
          {/*
            The registry is the authority: it spells the chord for the
            platform the user is on, and it tracks a rebinding from Settings.
            A hardcoded `⌘K` advertised a chord Windows and Linux users
            cannot press (#1649). `CommandPalette` registers the shortcut from
            a lazily-loaded chunk, so for the first tick the registry has
            nothing to say — the static default covers that window and is
            superseded the moment the chunk lands. It can only be wrong about
            a user's own rebinding, and only until then.
          */}
          {commandPaletteShortcut && commandPaletteShortcut !== 'Not set'
            ? commandPaletteShortcut
            : formatShortcutChord(['cmd'], 'k')}
        </button>
        <button
          type="button"
          className={`sidebar__footer-action${
            activeDestination?.id === NOTIFICATIONS.id
              ? ' sidebar__footer-action--active'
              : ''
          }`}
          aria-current={
            activeDestination?.id === NOTIFICATIONS.id ? 'page' : undefined
          }
          aria-label={`${notificationLabel}${
            notificationBadge ? ` (${notificationBadge.label})` : ''
          }`}
          title={notificationLabel}
          onClick={() => go(NOTIFICATIONS.route)}
        >
          <BellGlyph />
          {notificationBadge && (
            /* Capped at "9+" for the same reason the header bell is
               (#1132): this is an in-flow child of a fixed-width rail, so the
               badge's content width is the rail's. The exact count stays in
               the accessible name above, and the page this opens lists the
               items. */
            <span className="sidebar__footer-badge" aria-hidden="true">
              {notificationBadge.count > 9 ? '9+' : notificationBadge.count}
            </span>
          )}
        </button>
        <button
          type="button"
          className={`sidebar__footer-action${
            activeDestination?.id === SETTINGS.id
              ? ' sidebar__footer-action--active'
              : ''
          }`}
          aria-current={
            activeDestination?.id === SETTINGS.id ? 'page' : undefined
          }
          aria-label={settingsLabel}
          title={settingsLabel}
          onClick={() => go(SETTINGS.route)}
        >
          <SettingsGlyph />
        </button>
      </div>
    </div>
  );
}
