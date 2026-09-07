import { createPortal } from 'react-dom';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import { ArrowRightGlyph, InfoGlyph } from '../icons/Glyph';
import './HeaderMenu.css';
import type { HeaderHelpPrompt } from './utils';

interface HelpMenuProps {
  isOpen: boolean;
  prompts: HeaderHelpPrompt[];
  onClose: () => void;
  onSelectPrompt: (prompt: string) => void;
}

/**
 * #1552 D4: this menu had no CSS class at all — every rule of it was an inline
 * style, including a hand-written 8px radius, `padding: 10px 12px` rows, a
 * `borderBottom` between every prompt, and a pair of `onMouseEnter`/
 * `onMouseLeave` handlers assigning `style.background` because there was no
 * selector to hang `:hover` on. That made it the one menu in the shell whose
 * appearance could not be read from a stylesheet, and it agreed with none of the
 * other three. It wears `.menu-surface`/`.menu-row` now, and the hover is a
 * `:hover` rule like everywhere else.
 */
export function HelpMenu({
  isOpen,
  prompts,
  onClose,
  onSelectPrompt,
}: HelpMenuProps) {
  const menuRef = useMenuFocus<HTMLDivElement>(isOpen, onClose);
  if (!isOpen) return null;

  // Portalled for the same reason as the overflow menu: the mobile toolbar is
  // a stacking context at z-index 200 and clips its actions row, so a menu
  // rendered inside it cannot appear over the fixed mobile chrome.
  return createPortal(
    <>
      <button
        type="button"
        className="header-menu__dismiss-backdrop"
        aria-label="Close help menu"
        // One below the menu's own tier, derived from the same token, exactly as
        // the overflow and profile menus do: the backdrop must beat the fixed
        // mobile chrome to catch outside taps and stay under its own menu or it
        // swallows the menu's clicks.
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 'calc(var(--layer-navigation) - 1)',
        }}
        onClick={onClose}
      />
      {/* NO `role="menu"`, unchanged from before D4. This consolidation is about
          the VISUAL spec; the ARIA pattern each menu declares is its own, and
          changing this one's would change what owns the arrow keys (`useMenuFocus`
          installs roving focus for the menu role only) — the same reason
          `OverflowMenu` has always declined the role. That is a decision for
          whoever reviews this menu's keyboard model, not a side effect of a
          restyle. And with no role there is no `aria-label` either: a labelled
          element with no role is a name attached to nothing, which biome's
          `useAriaPropsSupportedByRole` is right about. The visible "Ask Station"
          group label below is what names this panel. */}
      <div
        ref={menuRef}
        className="menu-surface app-toolbar__help-menu"
        tabIndex={-1}
      >
        <div className="menu-group">
          <div className="menu-group__label">Ask Station</div>
          {prompts.map((promptConfig) => (
            <button
              type="button"
              className="menu-row"
              key={promptConfig.label}
              onClick={() => onSelectPrompt(promptConfig.prompt)}
            >
              <span className="menu-row__glyph" aria-hidden="true">
                <ArrowRightGlyph />
              </span>
              {promptConfig.label}
            </button>
          ))}
        </div>
        {/* #766 item 4: not an "Ask Station" prompt — opens the
            Report-a-problem dialog, which previews the captured context
            before the user chooses where the report goes. Its own group, so the
            4px group gap is what separates it from the prompts; the hairline
            that used to do that is gone with every other per-row rule (#1552
            D4). */}
        <div className="menu-group">
          <button
            type="button"
            className="menu-row"
            onClick={() => {
              onClose();
              // Inline literal, not `requestReportProblem` from
              // `lib/reportProblemEvents`: this menu is its own lazy chunk, and
              // importing that module here (it is also used inside the deferred
              // overlays chunk) hoists it into a shared chunk whose filename
              // costs the ENTRY chunk a preload-map record (~36 gzip bytes,
              // measured — the DeferredAppOverlays boundary comment documents
              // the mechanism). `HelpMenu.report-problem.test.tsx` binds this
              // literal to the constant behaviorally, so they cannot drift.
              window.dispatchEvent(
                new CustomEvent('station:open-report-problem'),
              );
            }}
          >
            <span className="menu-row__glyph" aria-hidden="true">
              <InfoGlyph />
            </span>
            Report a problem
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
