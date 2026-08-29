import { createPortal } from 'react-dom';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import './HeaderMenu.css';
import type { HeaderHelpPrompt } from './utils';

interface HelpMenuProps {
  isOpen: boolean;
  prompts: HeaderHelpPrompt[];
  onClose: () => void;
  onSelectPrompt: (prompt: string) => void;
}

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
        style={{ position: 'fixed', inset: 0, zIndex: 209 }}
        onClick={onClose}
      />
      <div
        ref={menuRef}
        style={{
          position: 'fixed',
          // The literal 40px matched no toolbar height on any surface.
          top: 'calc(var(--chat-visual-viewport-top, 0px) + var(--app-toolbar-total-height))',
          right: 8,
          zIndex: 210,
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
          borderRadius: 8,
          width: 'min(280px, calc(100vw - 32px))',
          boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '8px 12px',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            borderBottom: '1px solid var(--border-primary)',
          }}
        >
          Ask Station
        </div>
        {prompts.map((promptConfig, index) => (
          <button
            type="button"
            key={promptConfig.label}
            onClick={() => onSelectPrompt(promptConfig.prompt)}
            style={{
              display: 'flex',
              alignItems: 'center',
              width: '100%',
              padding: '10px 12px',
              border: 'none',
              background: 'transparent',
              color: 'var(--text-primary)',
              fontSize: 13,
              textAlign: 'left',
              cursor: 'pointer',
              borderBottom:
                index < prompts.length - 1
                  ? '1px solid var(--border-primary)'
                  : 'none',
              fontFamily: 'inherit',
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = 'var(--bg-tertiary)';
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = 'transparent';
            }}
          >
            <svg
              aria-hidden="true"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--text-muted)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0, marginRight: 8 }}
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            {promptConfig.label}
          </button>
        ))}
        {/* #766 item 4: not an "Ask Station" prompt — opens the
            Report-a-problem dialog, which previews the captured context
            before the user chooses where the report goes. */}
        <button
          type="button"
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
          style={{
            display: 'flex',
            alignItems: 'center',
            width: '100%',
            padding: '10px 12px',
            border: 'none',
            borderTop: '1px solid var(--border-primary)',
            background: 'transparent',
            color: 'var(--text-primary)',
            fontSize: 13,
            textAlign: 'left',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.background = 'var(--bg-tertiary)';
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background = 'transparent';
          }}
        >
          <svg
            aria-hidden="true"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--text-muted)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0, marginRight: 8 }}
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          Report a problem
        </button>
      </div>
    </>,
    document.body,
  );
}
