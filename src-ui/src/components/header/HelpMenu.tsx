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
      </div>
    </>,
    document.body,
  );
}
