import {
  type ConnectionIndicatorState,
  ConnectionStatusDot,
  type SavedConnection,
} from '@kontourai/station-connect';
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { navigationStore } from '../../contexts/navigation-store';
import { toastStore } from '../../contexts/ToastContext';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import {
  forgetStationProbe,
  isProbeable,
  matchesStationFilter,
  orderStations,
  probeStation,
  readRecentStations,
  type StationReachability,
} from '../../lib/stationSwitcher';
import { useStationConditions } from '../notifications/StationConditions';
import { openStationDetails } from '../notifications/stationDetailsEvents';
import { FilteredEmpty } from '../state';
import './HeaderMenu.css';

/** Below this many Stations a filter field is more clutter than help. */
const FILTER_THRESHOLD = 5;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnavailable(connection: SavedConnection): boolean {
  return Boolean(
    connection.injected &&
      (connection.injectedStatus === 'stopped' ||
        connection.injectedStatus === 'failed' ||
        connection.injectedStatus === 'starting'),
  );
}

function showError(text: string) {
  toastStore.show(text, undefined, 5000, undefined, undefined, 'error');
}

export function StationSwitcherMenu({
  anchor,
  connections,
  activeConnectionId,
  activeStatus,
  activeStatusLabel,
  onSelect,
  onForget,
  canForget: canForgetStation,
  onClose,
  onManage,
  onPairPhone,
}: {
  anchor: HTMLElement;
  connections: SavedConnection[];
  activeConnectionId?: string;
  activeStatus: ConnectionIndicatorState;
  activeStatusLabel: string;
  onSelect: (connection: SavedConnection) => Promise<void>;
  onForget: (connection: SavedConnection) => Promise<void>;
  /** Whether this device can forget the Station here at all. */
  canForget: (connection: SavedConnection) => boolean;
  onClose: () => void;
  onManage: () => void;
  onPairPhone?: () => void;
}) {
  const conditions = useStationConditions();
  const menuRef = useMenuFocus<HTMLDivElement>(true, onClose);
  const filterRef = useRef<HTMLInputElement>(null);
  const [position, setPosition] = useState({ right: 12, top: 0 });
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const switchingRef = useRef(false);
  const [filter, setFilter] = useState('');
  const [armedId, setArmedId] = useState<string | null>(null);
  const [bulkArmed, setBulkArmed] = useState(false);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const [reachability, setReachability] = useState<
    Record<string, StationReachability>
  >({});
  // Read once per opening: the order must not shuffle under the pointer.
  const [recent] = useState(readRecentStations);
  const promptId = useId();

  const ordered = useMemo(
    () =>
      orderStations(connections, activeConnectionId, recent).filter(
        (connection) => !removing.has(connection.id),
      ),
    [connections, activeConnectionId, recent, removing],
  );
  const showFilter = connections.length >= FILTER_THRESHOLD;
  const visible = ordered.filter((connection) =>
    matchesStationFilter(connection, filter),
  );

  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(300, window.innerWidth - 24);
    setPosition({
      right: Math.min(
        Math.max(12, window.innerWidth - rect.right),
        Math.max(12, window.innerWidth - width - 12),
      ),
      top: rect.bottom + 8,
    });
  }, [anchor]);
  // Escape first backs out of an armed Forget, then closes the menu.
  const disarmRef = useRef<() => boolean>(() => false);
  disarmRef.current = () => {
    if (armedId === null && !bulkArmed) return false;
    setArmedId(null);
    setBulkArmed(false);
    return true;
  };
  useEffect(() => {
    const dismissEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!disarmRef.current()) onClose();
    };
    document.addEventListener('keydown', dismissEscape);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('keydown', dismissEscape);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  // Declared after `useMenuFocus`, so this wins its first-item focus: the
  // filter when there is one, else the previous Station, so the switcher
  // shortcut followed by Enter flips back. A touch screen gets the row, not
  // the filter, so opening the switcher does not raise the keyboard.
  useEffect(() => {
    const coarse = window.matchMedia?.('(pointer: coarse)').matches === true;
    if (filterRef.current && !coarse) {
      filterRef.current.focus();
      return;
    }
    const previous = menuRef.current?.querySelector<HTMLElement>(
      '[data-station-row]:not([aria-checked="true"]):not(:disabled)',
    );
    if (previous) previous.focus();
    else if (coarse) menuRef.current?.focus();
  }, [menuRef]);
  useEffect(() => {
    let live = true;
    for (const connection of connections) {
      if (connection.id === activeConnectionId || !isProbeable(connection))
        continue;
      void probeStation(connection.url).then((result) => {
        if (live)
          setReachability((current) => ({
            ...current,
            [connection.id]: result,
          }));
      });
    }
    return () => {
      live = false;
    };
  }, [connections, activeConnectionId]);

  const select = (connection: SavedConnection) => {
    if (switchingRef.current || isUnavailable(connection)) return;
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
          showError(`Could not switch Stations: ${errorText(error)}`);
        });
    }, release);
  };

  const canForget = (connection: SavedConnection) =>
    switchingId === null &&
    connection.id !== activeConnectionId &&
    canForgetStation(connection);

  const forget = async (targets: SavedConnection[]) => {
    setArmedId(null);
    setBulkArmed(false);
    // Keep focus inside the menu: a focused row that unmounts would leave it
    // on <body>, and the menu dismisses itself when focus leaves.
    (filterRef.current ?? menuRef.current)?.focus();
    setRemoving((current) => {
      const next = new Set(current);
      for (const target of targets) next.add(target.id);
      return next;
    });
    const failed: string[] = [];
    for (const target of targets) {
      try {
        await onForget(target);
        forgetStationProbe(target.url);
      } catch (error) {
        failed.push(`${target.name || target.url}: ${errorText(error)}`);
        setRemoving((current) => {
          const next = new Set(current);
          next.delete(target.id);
          return next;
        });
      }
    }
    if (failed.length) showError(`Could not forget ${failed.join('; ')}`);
  };

  const unreachable = ordered.filter(
    (connection) =>
      canForget(connection) && reachability[connection.id] === 'unreachable',
  );

  const onRowKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    connection: SavedConnection,
  ) => {
    if (
      (event.key === 'Delete' || event.key === 'Backspace') &&
      canForget(connection)
    ) {
      event.preventDefault();
      setArmedId(connection.id);
      return;
    }
    if (
      filterRef.current &&
      /^\S$/.test(event.key) &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      // Type-to-filter from anywhere in the list.
      filterRef.current.focus();
    }
  };

  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const rows =
      menuRef.current?.querySelectorAll<HTMLElement>('[data-station-row]');
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      rows?.[0]?.focus();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target =
        visible.find(
          (connection) =>
            connection.id !== activeConnectionId && !isUnavailable(connection),
        ) ?? visible[0];
      if (target) select(target);
    }
  };

  const statusLabel = (connection: SavedConnection) => {
    if (switchingId === connection.id) return 'Switching…';
    if (connection.id === activeConnectionId) return activeStatusLabel;
    if (isUnavailable(connection)) return 'Not running';
    if (
      connection.credentialState === 'required' ||
      connection.lastError?.reason === 'authentication-failed'
    )
      return 'Needs access';
    const probed = reachability[connection.id];
    if (probed === 'online') return 'Online';
    if (probed === 'unreachable') return 'Unreachable';
    if (isProbeable(connection) && !probed) return '';
    return connection.lastError ? "Can't connect" : '';
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
        // Escape belongs to this menu while it is open, not to "go up a level".
        data-escape-owner=""
        tabIndex={-1}
        className="menu-surface app-toolbar__station-switcher"
        style={position}
      >
        {showFilter && (
          <input
            ref={filterRef}
            type="search"
            className="station-switcher__filter"
            placeholder="Find a Station"
            aria-label="Find a Station"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setArmedId(null);
            }}
            onKeyDown={onFilterKeyDown}
          />
        )}
        {/* The filter and its empty state sit beside the menu: a menu may own
            only its items. */}
        {visible.length === 0 && (
          <FilteredEmpty
            query={filter}
            title={`Nothing matches “${filter.trim()}”`}
            onClear={() => {
              setFilter('');
              filterRef.current?.focus();
            }}
          />
        )}
        <div role="menu" aria-label="Choose Station">
          <div role="none" className="station-switcher__profiles">
            {visible.map((connection, index) => {
              const current = connection.id === activeConnectionId;
              const unavailable = isUnavailable(connection);
              const probed = reachability[connection.id];
              const status: ConnectionIndicatorState = current
                ? activeStatus
                : probed === 'unreachable' || connection.lastError
                  ? 'error'
                  : probed === 'online'
                    ? 'connected'
                    : 'idle';
              const name = connection.name || connection.url;
              const label = statusLabel(connection);
              const armed = armedId === connection.id;
              // A healthy peer says so with its dot alone; text is for the
              // active Station and for anything that needs attention.
              const shown = armed
                ? 'Forget on this device?'
                : label === 'Online'
                  ? ''
                  : label;
              return (
                <div
                  key={connection.id}
                  role="none"
                  className="station-switcher__item"
                >
                  <button
                    type="button"
                    role="menuitemradio"
                    data-station-row=""
                    aria-checked={current}
                    aria-label={label ? `${name} — ${label}` : name}
                    aria-describedby={
                      armed ? `${promptId}-${index}` : undefined
                    }
                    aria-keyshortcuts={
                      canForget(connection) ? 'Delete' : undefined
                    }
                    disabled={switchingId !== null || unavailable}
                    className="menu-row station-switcher__row"
                    onClick={() => select(connection)}
                    onKeyDown={(event) => onRowKeyDown(event, connection)}
                  >
                    <span aria-hidden="true">
                      <ConnectionStatusDot status={status} size={8} />
                    </span>
                    <span className="station-switcher__identity">
                      <span className="station-switcher__name" title={name}>
                        {name}
                      </span>
                      {shown && (
                        <span
                          id={`${promptId}-${index}`}
                          className="station-switcher__status"
                        >
                          {shown}
                        </span>
                      )}
                    </span>
                    {current && <span aria-hidden="true">✓</span>}
                  </button>
                  {canForget(connection) && (
                    <button
                      type="button"
                      role="menuitem"
                      data-roving-skip=""
                      tabIndex={-1}
                      // Armed by Delete on the row, the confirm takes focus so
                      // Enter forgets; Escape or leaving it backs out.
                      ref={(node) => {
                        if (armed) node?.focus();
                      }}
                      className={`station-switcher__remove${armed ? ' station-switcher__remove--armed' : ''}`}
                      aria-label={`Forget ${name}`}
                      aria-describedby={
                        armed ? `${promptId}-${index}` : undefined
                      }
                      title={armed ? undefined : 'Forget'}
                      onBlur={() => {
                        if (armed) setArmedId(null);
                      }}
                      onClick={() => {
                        if (armed) void forget([connection]);
                        else setArmedId(connection.id);
                      }}
                    >
                      {armed ? 'Forget' : '×'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {unreachable.length >= 2 && !filter && (
            <button
              type="button"
              role="menuitem"
              className={`menu-row station-switcher__bulk${bulkArmed ? ' station-switcher__bulk--armed' : ''}`}
              onBlur={() => setBulkArmed(false)}
              onClick={() => {
                if (bulkArmed) void forget(unreachable);
                else setBulkArmed(true);
              }}
            >
              {bulkArmed
                ? `Forget ${unreachable
                    .map((connection) => connection.name || connection.url)
                    .join(', ')}?`
                : `Forget ${unreachable.length} unreachable`}
            </button>
          )}
          <div role="none" className="station-switcher__footer">
            <button
              type="button"
              role="menuitem"
              className="menu-row"
              aria-label={`Station details${conditions.length ? ` · ${conditions.length} notices` : ''}`}
              onClick={() => {
                onClose();
                openStationDetails();
              }}
            >
              Details{conditions.length ? ` · ${conditions.length}` : ''}
            </button>
            {onPairPhone && (
              <button
                type="button"
                role="menuitem"
                className="menu-row"
                onClick={() => {
                  onClose();
                  onPairPhone();
                }}
              >
                Pair phone
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="menu-row"
              aria-label="Manage Stations"
              onClick={() => {
                onClose();
                onManage();
              }}
            >
              Manage
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
