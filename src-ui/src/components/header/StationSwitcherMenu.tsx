import {
  type ConnectionIndicatorState,
  ConnectionStatusDot,
  type SavedConnection,
} from '@kontourai/station-connect';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { navigationStore } from '../../contexts/navigation-store';
import { toastStore } from '../../contexts/ToastContext';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import './HeaderMenu.css';

export function StationSwitcherMenu({
  anchor,
  connections,
  activeConnectionId,
  activeStatus,
  activeStatusLabel,
  onSelect,
  onClose,
  onManage,
}: {
  anchor: HTMLElement;
  connections: SavedConnection[];
  activeConnectionId?: string;
  activeStatus: ConnectionIndicatorState;
  activeStatusLabel: string;
  onSelect: (connection: SavedConnection) => Promise<void>;
  onClose: () => void;
  onManage: () => void;
}) {
  const menuRef = useMenuFocus<HTMLDivElement>(true, onClose);
  const [position, setPosition] = useState({ right: 12, top: 0 });
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const switchingRef = useRef(false);
  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(280, window.innerWidth - 24);
    setPosition({
      right: Math.min(
        Math.max(12, window.innerWidth - rect.right),
        Math.max(12, window.innerWidth - width - 12),
      ),
      top: rect.bottom + 8,
    });
  }, [anchor]);
  useEffect(() => {
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', dismissEscape);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('keydown', dismissEscape);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  const select = (connection: SavedConnection) => {
    if (switchingRef.current) return;
    if (connection.id === activeConnectionId) {
      onClose();
      return;
    }
    switchingRef.current = true;
    setSwitchingId(connection.id);
    const release = () => {
      switchingRef.current = false;
      setSwitchingId(null);
    };
    navigationStore.runNavigationGuards(() => {
      void onSelect(connection)
        .then(onClose)
        .catch((error) => {
          release();
          toastStore.show(
            `Could not switch Stations: ${error instanceof Error ? error.message : String(error)}`,
            undefined,
            5000,
            undefined,
            undefined,
            'error',
          );
        });
    }, release);
  };
  return createPortal(
    <>
      <button
        type="button"
        tabIndex={-1}
        className="header-menu__dismiss-backdrop"
        aria-label="Close Station switcher"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 'calc(var(--layer-navigation) - 1)',
        }}
        onPointerDown={(event) => event.preventDefault()}
        onPointerCancel={onClose}
        onClick={onClose}
      />
      <div
        ref={menuRef}
        role="menu"
        aria-label="Choose Station"
        tabIndex={-1}
        className="menu-surface app-toolbar__station-switcher"
        style={position}
      >
        <div className="station-switcher__profiles">
          {connections.map((connection) => {
            const current = connection.id === activeConnectionId;
            const unavailable =
              connection.injected &&
              (connection.injectedStatus === 'stopped' ||
                connection.injectedStatus === 'failed' ||
                connection.injectedStatus === 'starting');
            const status = current
              ? activeStatus
              : connection.lastError
                ? 'error'
                : 'idle';
            const label = current
              ? activeStatusLabel
              : unavailable
                ? 'Not running'
                : connection.credentialState === 'required' ||
                    connection.lastError?.reason === 'authentication-failed'
                  ? 'Needs access'
                  : connection.lastError
                    ? "Can't connect"
                    : 'Not checked';
            const name = connection.name || connection.url;
            return (
              <button
                key={connection.id}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                aria-label={`${name} — ${label}`}
                disabled={switchingId !== null || unavailable}
                className="menu-row station-switcher__row"
                onClick={() => select(connection)}
              >
                <span aria-hidden="true">
                  <ConnectionStatusDot status={status} size={8} />
                </span>
                <span className="station-switcher__identity">
                  <span>{name}</span>
                  <span className="station-switcher__status">
                    {switchingId === connection.id ? 'Switching…' : label}
                  </span>
                </span>
                {current && <span aria-hidden="true">✓</span>}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          role="menuitem"
          className="menu-row"
          onClick={() => {
            onClose();
            onManage();
          }}
        >
          Manage Stations
        </button>
      </div>
    </>,
    document.body,
  );
}
