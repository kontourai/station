import { Fragment, forwardRef } from 'react';
// Self-imported for the same reason `components/Tabs.tsx` self-imports it —
// see that file's comment (archive#3306).
import '../views/page-layout.css';

/**
 * The shared scroll-spy / URL-section navigation primitive (archive#4463).
 * For the family that switches a deep-linkable URL
 * section — Settings, ProjectSettingsView, KnowledgeConnectionView — NOT
 * for true in-place tab widgets; those use `components/Tabs.tsx` instead.
 *
 * This renders a `<nav>` landmark of real `<a aria-current="location">`
 * anchors sharing `Tabs`' `.page__tab` pill visual, so the two read as one
 * design language while staying semantically honest about which job each is
 * doing. Consequences of being real navigation, not a tab widget:
 * - Normal Tab-key focus order (the browser's native links rotor), NOT
 *   roving tabindex — every link is independently reachable and a screen
 *   reader's link-list/rotor sees every one of them, which `role="tab"`
 *   would have hidden.
 * - No arrow-key activation. Wiring arrow keys to `onNavigate` (as an
 *   earlier version of this fix did) reproduced two real defects: an
 *   arrow-key press pushed a browser history entry per keystroke, and the
 *   host's own deep-link "reveal" effect (`focusSection` in
 *   `useSectionNavigation`) then stole focus back out of the strip —
 *   archive#4463.
 * - Ctrl/Cmd/Shift/Alt+click bails out BEFORE `preventDefault`, so a
 *   modified click still opens the section in a new tab / window exactly
 *   like any other link, rather than always hijacking the click into an
 *   in-app navigation.
 */
export interface SectionNavItem {
  /** Stable identity — what `activeKey` compares against and `onNavigate` receives. */
  key: string;
  label: string;
  /** The real, bookmarkable URL for this section (typically `hrefForSection(id)`). */
  href: string;
  /**
   * Draws a real, presentational divider element after this item — the
   * non-textual stand-in for a scope-group boundary (Settings' Station /
   * Defaults / This device). A dedicated `aria-hidden` element, not a
   * border on the item itself: an earlier version put the divider on the
   * LAST item's own border, which visibly conflicted with that same item's
   * active-pill border when it was also the selected tab.
   */
  dividerAfter?: boolean;
}

export interface SectionNavProps {
  items: readonly SectionNavItem[];
  activeKey: string;
  onNavigate: (key: string) => void;
  /** Required — every nav landmark needs an accessible name distinguishing it from other navs on the page. */
  'aria-label': string;
  /** Extra class(es) merged onto the `.section-nav` strip, for a host's own layout hooks. */
  className?: string;
}

export const SectionNav = forwardRef<HTMLElement, SectionNavProps>(
  function SectionNav(
    { items, activeKey, onNavigate, 'aria-label': ariaLabel, className },
    forwardedRef,
  ) {
    const stripClassName = ['section-nav', className ?? null]
      .filter(Boolean)
      .join(' ');
    return (
      <nav ref={forwardedRef} className={stripClassName} aria-label={ariaLabel}>
        {items.map((item) => {
          const selected = item.key === activeKey;
          return (
            <Fragment key={item.key}>
              <a
                href={item.href}
                aria-current={selected ? 'location' : undefined}
                className={
                  selected ? 'page__tab page__tab--active' : 'page__tab'
                }
                onClick={(event) => {
                  // A modified click means "open elsewhere" — let the
                  // browser's native link behavior win, same as any other
                  // anchor on the page.
                  if (
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  ) {
                    return;
                  }
                  event.preventDefault();
                  onNavigate(item.key);
                }}
              >
                {item.label}
              </a>
              {item.dividerAfter ? (
                <span aria-hidden="true" className="section-nav__divider" />
              ) : null}
            </Fragment>
          );
        })}
      </nav>
    );
  },
);
