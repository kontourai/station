import type {
  BrowserSessionView,
  BrowserViewportView,
  WorkspaceBrowserPaneMigration,
} from '@kontourai/station-contracts/workspace-browser-pane';
import { authenticatedFetch } from '@kontourai/station-sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { showChatPageOrDock } from '../../app-shell/chat-placement';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import {
  ArrowLeftGlyph,
  ArrowRightGlyph,
  ArrowUpGlyph,
  BoardGlyph,
  CameraGlyph,
  CloseGlyph,
  EditGlyph,
  GlobeGlyph,
  glyph,
  LockGlyph,
  MessageGlyph,
  MoonGlyph,
  PauseGlyph,
  PhoneGlyph,
  RecordGlyph,
  RefreshGlyph,
  SearchGlyph,
  SettingsGlyph,
  TerminalGlyph,
} from '../../components/icons/Glyph';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import {
  useApiBase,
  useHostRequestAuthorityScope,
} from '../../contexts/ApiBaseContext';
import { activeChatsStore } from '../../contexts/active-chats-store';
import {
  type KeyboardShortcut,
  setShortcutContext,
  useOptionalKeyboardShortcuts,
} from '../../contexts/KeyboardShortcutsContext';
import { navigationStore } from '../../contexts/navigation-store';
import {
  browserFloatSourceKey,
  browserShownSourceKey,
} from '../../float-over-chat/floatSource';
import {
  isFloatSourceOpen,
  requestFloat,
  useFloatHostAvailable,
  useFloatStoreVersion,
} from '../../float-over-chat/floatStore';
import {
  agentInputOf,
  DRIVER_TEXT,
  useRecentDriver,
} from '../../float-over-chat/recentDriver';
import { usePaneSourceVisibility } from '../../float-over-chat/shownSources';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import {
  LiveSurfaceCanvas,
  type LiveSurfaceControllerTone,
  type LiveSurfaceControlState,
} from '../../live-surface/LiveSurfaceCanvas';
import { StationUiError } from '../../utils/StationUiError';
import { describeStationFailure } from '../../utils/stationFailure';
import { type PaneMenuItem, PaneOverflowMenu } from '../PaneOverflowMenu';
import { BrowserAcquisitionPanel } from './BrowserAcquisitionPanel';
import { BrowserAnnotationFlow } from './BrowserAnnotationFlow';
import {
  BrowserConsoleDrawer,
  useBrowserConsole,
} from './BrowserConsoleDrawer';
import { BrowserImmersiveNav } from './BrowserImmersiveNav';
import { BrowserNetworkDrawer } from './BrowserNetworkDrawer';
import { BrowserPageDialog } from './BrowserPageDialog';
import {
  BrowserRecordingStatus,
  useBrowserRecording,
} from './BrowserRecording';
import {
  BrowserScreenshot,
  type BrowserScreenshotShot,
} from './BrowserScreenshot';
import {
  BrowserSessionList,
  describeBrowserAction,
} from './BrowserSessionList';
import { BrowserTabs } from './BrowserTabs';
import { browserAddressInput } from './browserAddressInput';
import { BROWSER_PAGE_CONTENT_NOTICE } from './browserArtifactContent';
import {
  BROWSER_DEVICE_PRESETS,
  presetFor,
  viewportForV1Preference,
  viewportToFill,
} from './browserDevicePresets';
import {
  BrowserApiError,
  type BrowserFetch,
  type BrowserPaneApi,
  browserFailureHelpUrl,
  browserPaneApi,
  browserPaneKeys,
  describeBrowserFailure,
} from './browserPaneApi';
import { useBrowserArtifactIntake } from './useBrowserArtifactIntake';
import './BrowserPane.css';

/**
 * Browser pane v2 (#90): a server-side Chromium page, streamed live
 * (`LiveSurfaceCanvas`) and driven from here. The session is SERVER-owned;
 * this pane only remembers which one it shows on this device.
 *
 * Every state is said as it is: unavailable on a hosted Station, refused to
 * a caller who is not the operator or a Project admin, waiting on the
 * operator's consent to download Chromium, a browser that stopped and needs
 * reopening, a session that no longer exists.
 *
 * Quiet chrome, one row: an omnibox (lock, host, path; back and forward on
 * hover or focus, always on a coarse pointer; reload), a one-word driver
 * chip ("Agent" / "You", the float-over-chat's rule), Console with a count
 * of unseen errors, and ⋯ (Screenshot, Viewport, Sessions, Agent access,
 * Local servers, then Close session). Taking control is a click on the page;
 * the chip hands it back. A dialog the page shows while this person is in
 * control waits for their answer over the live view.
 */

export type BrowserPaneTarget =
  | { kind: 'session'; browserSessionId: string }
  | { kind: 'migrate'; migration: WorkspaceBrowserPaneMigration }
  /** Opened from the Add-pane grid: no session yet. */
  | { kind: 'new' };

export interface BrowserPaneProps {
  projectSlug: string;
  target: BrowserPaneTarget;
  /** Persist that this pane now shows `browserSessionId` (pane state v2). */
  onAttach: (browserSessionId: string) => void;
  browserSessionIds?: string[];
  onTabsChange?: (ids: string[], selected: string) => void;
  /** Test seam; defaults to the SDK's `authenticatedFetch`. */
  transport?: BrowserFetch;
}

const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** Mod+Shift+S, said the way this platform says it. */
const SCREENSHOT_SHORTCUT = IS_MAC
  ? { label: '⇧⌘S', aria: 'Meta+Shift+S' }
  : { label: 'Ctrl+Shift+S', aria: 'Control+Shift+S' };
const HARD_RELOAD_SHORTCUT = IS_MAC
  ? { label: '⇧⌘R', aria: 'Meta+Shift+R' }
  : { label: 'Ctrl+Shift+R', aria: 'Control+Shift+R' };
const BROWSER_ZOOM_STEPS = [
  0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2,
];

/** Host and the rest of the URL, for the omnibox's two weights. */
function addressParts(url: string): {
  host: string;
  path: string;
  secure: boolean;
} {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return { host: url, path: '', secure: false };
    const rest = `${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}${parsed.hash}`;
    return {
      host: parsed.host,
      path: rest,
      secure: parsed.protocol === 'https:',
    };
  } catch {
    return { host: url, path: '', secure: false };
  }
}

/** A quarter-turn arrow: swap the viewport's width and height. */
const RotateGlyph = /* @__PURE__ */ glyph(
  'M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 2.5v3h-3',
);

/** Three dots, the overflow glyph (kit stroke, 16px box). */
function MoreGlyph() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="1em"
      height="1em"
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.5" cy="8" r="1.2" />
    </svg>
  );
}

/**
 * Who drives, in one word: "Agent" (a breathing dot while an agent drove
 * recently) or "You". Taking control needs no button: a click or a key on
 * the page takes it. When this person holds control, the chip opens a tiny
 * menu to hand it back (disabled while the page's dialog waits).
 */
function BrowserDriverChip({
  tone,
  canRelease,
  releaseLabel,
  releaseBlocked,
  onRelease,
  api,
  apiBase,
  browserSessionId,
}: {
  tone: LiveSurfaceControllerTone;
  canRelease: boolean;
  releaseLabel: string;
  releaseBlocked: boolean;
  onRelease: () => void;
  api: BrowserPaneApi;
  apiBase: string;
  browserSessionId: string;
}) {
  const coarsePointer = useCoarsePointer();
  const [open, setOpen] = useState(false);
  const menuRef = useMenuFocus<HTMLDivElement>(open, () => setOpen(false));
  const history = useQuery({
    queryKey: browserPaneKeys.fullHistory(apiBase, browserSessionId),
    queryFn: ({ signal }) => api.session(browserSessionId, signal),
    enabled: open,
    refetchInterval: open ? 3000 : false,
  });
  if (tone === 'none')
    return (
      <span className="sr-only" aria-live="polite">
        {DRIVER_TEXT.none}
      </span>
    );
  const word = tone === 'agent' ? 'Agent' : tone === 'you' ? 'You' : 'Other';
  const live = (
    <span className="sr-only" aria-live="polite">
      {DRIVER_TEXT[tone]}
    </span>
  );
  return (
    <span className="browser-pane__chip-wrap">
      <button
        type="button"
        className="browser-pane__chip browser-pane__chip--button"
        data-tone={tone}
        aria-label={`${DRIVER_TEXT[tone]}. ${canRelease ? 'Control options' : 'Recent actions'}`}
        title={
          tone === 'agent'
            ? `${DRIVER_TEXT.agent}. ${coarsePointer ? 'Tap' : 'Click'} the page to take over.`
            : DRIVER_TEXT[tone]
        }
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="browser-pane__chip-dot" aria-hidden="true" />
        <span aria-hidden="true">{word}</span>
      </button>
      {live}
      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Control"
          tabIndex={-1}
          className="menu-surface browser-pane__chip-menu"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          {canRelease ? (
            <button
              type="button"
              role="menuitem"
              className="menu-row pane-menu__row"
              disabled={releaseBlocked}
              title={
                releaseBlocked ? 'Answer the page’s dialog first.' : undefined
              }
              onClick={() => {
                setOpen(false);
                onRelease();
              }}
            >
              <span className="menu-row__glyph" aria-hidden="true">
                <ArrowUpGlyph />
              </span>
              {releaseLabel}
            </button>
          ) : null}
          <section aria-label="Recent actions">
            {history.isPending ? (
              <SkeletonBlock count={1} label="Loading recent actions" />
            ) : history.isError ? (
              'Could not load actions.'
            ) : (
              <ol className="browser-pane__history">
                {history.data.history.entries
                  .slice(-20)
                  .reverse()
                  .map((action) => (
                    <li key={action.seq}>
                      <time dateTime={action.at}>
                        {new Date(action.at).toLocaleTimeString()}
                      </time>{' '}
                      {describeBrowserAction(action)}
                    </li>
                  ))}
              </ol>
            )}
          </section>
        </div>
      ) : null}
    </span>
  );
}

/** A viewport's identity: any field that changes what the page lays out. */
function viewportKey(viewport: BrowserViewportView): string {
  return `${viewport.width}x${viewport.height}@${viewport.deviceScaleFactor}${viewport.mobile ? ' mobile' : ''}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function stoppedReason(session: BrowserSessionView): string {
  switch (session.endReason) {
    case 'host-exited':
      return 'The browser process exited, possibly after a crash.';
    case 'server-stopped':
    case 'server-restarted':
      return 'Station restarted, so this session’s browser was stopped.';
    default:
      return 'The browser behind this session is not running.';
  }
}

export default function BrowserPane({
  projectSlug,
  target,
  onAttach,
  browserSessionIds,
  onTabsChange,
  transport = authenticatedFetch,
}: BrowserPaneProps) {
  const { apiBase } = useApiBase();
  const requestScope = useHostRequestAuthorityScope();
  const api = useMemo(
    () => browserPaneApi(apiBase, transport),
    [apiBase, transport],
  );
  const queryClient = useQueryClient();
  const visibility = useSurfaceVisibilityFlags();
  const [browserFocused, setBrowserFocused] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!browserFocused) return;
    const leave = (event: Event) => {
      const target = event.target;
      if (
        target instanceof Element &&
        (workspaceRef.current?.contains(target) ||
          target.closest('.command-palette-overlay, .pane-menu'))
      )
        return;
      setBrowserFocused(false);
    };
    document.addEventListener('focusin', leave);
    document.addEventListener('pointerdown', leave);
    return () => {
      document.removeEventListener('focusin', leave);
      document.removeEventListener('pointerdown', leave);
    };
  }, [browserFocused]);
  const access = useQuery({
    queryKey: browserPaneKeys.access(apiBase, projectSlug),
    queryFn: ({ signal }) => api.access(projectSlug, signal),
    retry: false,
  });
  const onReady = useCallback(
    () =>
      void queryClient.invalidateQueries({
        queryKey: browserPaneKeys.access(apiBase, projectSlug),
      }),
    [apiBase, projectSlug, queryClient],
  );

  if (access.isPending)
    return (
      <div className="browser-pane">
        <SkeletonBlock count={2} label="Opening the browser" />
      </div>
    );
  if (access.isError) {
    const error = access.error;
    const status = error instanceof BrowserApiError ? error.status : 0;
    return (
      <div className="browser-pane">
        {status === 404 ? (
          <Empty
            label="The browser isn't available on this Station"
            description="It runs only on a personal Station host, not on a shared or hosted deployment."
          />
        ) : status === 403 || status === 401 ? (
          <ErrorState
            title={
              error instanceof BrowserApiError &&
              error.code === 'project-not-found'
                ? 'Project not found'
                : error instanceof BrowserApiError &&
                    (error.code === 'stale-sign-in' || status === 401)
                  ? 'Sign in again'
                  : "The browser isn't available to you"
            }
            description={
              error instanceof BrowserApiError &&
              error.code === 'project-not-found'
                ? 'Open an existing Project, then try again.'
                : error instanceof BrowserApiError &&
                    (error.code === 'stale-sign-in' || status === 401)
                  ? 'Reconnect this device to this Station, then try again.'
                  : "Ask the Station operator to grant you Project admin access, or open the Browser on the operator's device."
            }
            action={
              <Button
                className="browser-pane__control"
                onClick={() => void access.refetch()}
              >
                Retry
              </Button>
            }
          />
        ) : (
          <ErrorState
            title="Station could not reach the browser"
            description={describeBrowserFailure(error)}
            action={
              <Button
                className="browser-pane__control"
                onClick={() => void access.refetch()}
              >
                Retry
              </Button>
            }
          />
        )}
      </div>
    );
  }
  if (access.data.browser !== 'ready')
    return (
      <div className="browser-pane">
        <BrowserAcquisitionPanel
          apiBase={apiBase}
          api={api}
          operator={access.data.operator}
          onReady={onReady}
        />
      </div>
    );
  if (target.kind === 'new')
    return (
      <div className="browser-pane">
        <BrowserNewSession
          apiBase={apiBase}
          api={api}
          projectSlug={projectSlug}
          onAttach={onAttach}
          canDrive={access.data.canDrive !== false}
        />
      </div>
    );
  if (target.kind === 'migrate')
    return (
      <div className="browser-pane">
        {access.data.canDrive === false ? (
          <BrowserNewSession
            apiBase={apiBase}
            api={api}
            projectSlug={projectSlug}
            onAttach={onAttach}
            canDrive={false}
          />
        ) : (
          <BrowserMigration
            api={api}
            projectSlug={projectSlug}
            migration={target.migration}
            onAttach={onAttach}
          />
        )}
      </div>
    );
  return (
    <div
      className="browser-pane__workspace"
      ref={workspaceRef}
      onFocusCapture={() => setBrowserFocused(true)}
      onBlurCapture={(event) => {
        const next = event.relatedTarget;
        if (
          next instanceof Element &&
          (event.currentTarget.contains(next) ||
            next.closest('.command-palette-overlay, .pane-menu'))
        )
          return;
        setBrowserFocused(false);
      }}
    >
      {browserSessionIds && onTabsChange ? (
        <BrowserTabs
          apiBase={apiBase}
          api={api}
          projectSlug={projectSlug}
          ids={browserSessionIds}
          selected={target.browserSessionId}
          onSelect={onAttach}
          onChange={onTabsChange}
          readOnly={access.data.canDrive === false}
          browserFocused={browserFocused}
          experienceEnabled={
            access.data.experiencePreviewEnabled === true &&
            visibility.has('browser-experience')
          }
        />
      ) : null}
      <BrowserSessionPane
        key={target.browserSessionId}
        apiBase={apiBase}
        api={api}
        projectSlug={projectSlug}
        browserSessionId={target.browserSessionId}
        canDrive={access.data.canDrive !== false}
        browserFocused={browserFocused}
        experienceEnabled={
          access.data.experiencePreviewEnabled === true &&
          visibility.has('browser-experience')
        }
        requestScope={requestScope}
        onAttach={onAttach}
        transport={transport}
      />
    </div>
  );
}

/**
 * A v1 Browser Preview pane, on its first mount under v2: restore the
 * caller's OWN open session for the same address, or open a new one, and
 * attach. The server does the matching (`reuse`), in the caller's profile
 * and on the exact normalized URL; it may also refuse the URL.
 */
function BrowserMigration({
  api,
  projectSlug,
  migration,
  onAttach,
}: {
  api: BrowserPaneApi;
  projectSlug: string;
  migration: WorkspaceBrowserPaneMigration;
  onAttach: (browserSessionId: string) => void;
}) {
  const migrate = useMutation({
    mutationFn: async () => {
      const viewport = viewportForV1Preference(migration.viewportPreference);
      return api.create({
        projectSlug,
        url: migration.requestedUrl,
        reuse: true,
        ...(viewport ? { viewport } : {}),
      });
    },
    onSuccess: (session) => onAttach(session.browserSessionId),
  });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    migrate.mutate();
  }, [migrate]);
  if (migrate.isError)
    return (
      <ErrorState
        title={`Station could not open ${migration.requestedUrl}`}
        description={describeBrowserFailure(
          migrate.error,
          migration.requestedUrl,
        )}
        action={
          <Button
            className="browser-pane__control"
            onClick={() => migrate.mutate()}
          >
            Retry
          </Button>
        }
      />
    );
  return (
    <SkeletonBlock
      count={2}
      label={`Opening ${migration.requestedUrl} in the browser`}
    />
  );
}

/**
 * Sessions this tab just opened from its own address field or server list. On
 * a narrow pane, the opening pane sizes the new page to itself once, as soon
 * as it is live (see `NARROW_PANE_WIDTH`). A session someone else opened, or
 * one this pane attaches to later, keeps its viewport: that is shared.
 */
const sizeToOpeningPane = new Set<string>();

/** Below this stage width (CSS px) a new page opens at the pane's own size. */
export const NARROW_PANE_WIDTH = 600;

/** A pane with no session yet: open a page, or attach to an existing one. */
function BrowserNewSession({
  apiBase,
  api,
  projectSlug,
  onAttach,
  canDrive,
}: {
  apiBase: string;
  api: BrowserPaneApi;
  projectSlug: string;
  onAttach: (browserSessionId: string) => void;
  canDrive: boolean;
}) {
  const [address, setAddress] = useState('');
  const addressRef = useRef<HTMLInputElement>(null);
  const open = useMutation({
    mutationFn: (url: string) =>
      api.create({ projectSlug, url: browserAddressInput(url) }),
    onSuccess: (session) => {
      sizeToOpeningPane.add(session.browserSessionId);
      onAttach(session.browserSessionId);
    },
  });
  const targets = useQuery({
    queryKey: browserPaneKeys.localTargets(apiBase, projectSlug),
    queryFn: ({ signal }) => api.localTargets(projectSlug, signal),
    enabled: canDrive,
    retry: false,
  });
  return (
    <>
      {canDrive ? (
        <div className="browser-pane__start">
          <h2 className="browser-pane__start-kicker">Browser</h2>
          <h3 className="browser-pane__start-title">Open a page</h3>
          <form
            className="browser-pane__nav"
            aria-label="Open a page"
            onSubmit={(event) => {
              event.preventDefault();
              // Put a phone's keyboard away: it covers the page that opens.
              addressRef.current?.blur();
              open.mutate(address.trim() || 'about:blank');
            }}
          >
            <input
              ref={addressRef}
              className="browser-pane__address"
              aria-label="Address"
              placeholder="Search or enter an address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
              enterKeyHint="go"
            />
            <Button
              type="submit"
              variant="primary"
              className="browser-pane__control browser-pane__open"
              pending={open.isPending}
              aria-label="Open address"
              title="Open address"
            >
              <ArrowRightGlyph />
            </Button>
          </form>
          {targets.isPending ? (
            <SkeletonBlock count={1} label="Loading local servers" />
          ) : targets.isError ? (
            <ErrorState
              variant="compact"
              title="Local servers could not be read"
              description={describeBrowserFailure(targets.error)}
              action={
                <Button
                  size="sm"
                  className="browser-pane__control"
                  onClick={() => void targets.refetch()}
                >
                  Retry
                </Button>
              }
            />
          ) : targets.data.length ? (
            <ul className="browser-pane__targets" aria-label="Local servers">
              {targets.data.map((target) => (
                <li key={target.id}>
                  <Button
                    size="sm"
                    className="browser-pane__control"
                    disabled={open.isPending}
                    onClick={() =>
                      open.mutate(
                        `http://${target.host.includes(':') ? `[${target.host}]` : target.host}:${target.port}/`,
                      )
                    }
                  >
                    {target.label} · {target.host}:{target.port}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty
              variant="compact"
              label="Local servers appear here once shared"
              description="The operator shares them in Settings › Advanced › Browser & devices."
            />
          )}
        </div>
      ) : (
        <p className="browser-pane__hint">Choose a session to watch.</p>
      )}
      {open.isError ? (
        <BrowserOpenFailureNotice error={open.error} typed={address} />
      ) : null}
      <BrowserSessionList
        apiBase={apiBase}
        api={api}
        projectSlug={projectSlug}
        onOpen={onAttach}
        hideWhenEmpty
      />
    </>
  );
}

function BrowserSessionPane({
  apiBase,
  api,
  projectSlug,
  browserSessionId,
  canDrive,
  browserFocused,
  experienceEnabled,
  requestScope,
  onAttach,
  transport,
}: {
  apiBase: string;
  api: BrowserPaneApi;
  projectSlug: string;
  browserSessionId: string;
  canDrive: boolean;
  browserFocused: boolean;
  experienceEnabled: boolean;
  requestScope: ReturnType<typeof useHostRequestAuthorityScope>;
  onAttach: (browserSessionId: string) => void;
  transport: BrowserFetch;
}) {
  const queryClient = useQueryClient();
  const attachFiles = useBrowserArtifactIntake();
  const sessionKey = browserPaneKeys.session(apiBase, browserSessionId);
  /** Who controls the live view, as the canvas's own stream reports it. */
  const [control, setControl] = useState<LiveSurfaceControlState | null>(null);
  const holdingRef = useRef(false);
  holdingRef.current = control?.tone === 'you';
  const session = useQuery({
    queryKey: sessionKey,
    // The summary (latest few actions) is what polls; the full history is
    // read only when someone opens it.
    queryFn: ({ signal }) => api.sessionSummary(browserSessionId, signal),
    retry: false,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      if (state === 'opening') return 1_000;
      // While this person drives, a dialog their input opens must reach
      // them quickly: the page is waiting on it.
      if (state === 'live') return holdingRef.current ? 1_000 : 3_000;
      // Slowly, so a reopen from another device is noticed here too.
      if (state === 'needs-reopen') return 10_000;
      return false;
    },
  });
  const [panel, setPanel] = useState<
    'none' | 'sessions' | 'console' | 'network'
  >('none');
  const [addressFocused, setAddressFocused] = useState(false);
  const artifactsEnabled = useSurfaceVisibilityFlags().has('browser-artifacts');
  const paneRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const shortcutStore = useOptionalKeyboardShortcuts();
  const shortcutActions = useRef<Record<string, () => void>>({});
  const coarsePointer = useCoarsePointer();
  const narrow = useIsMobile();
  const [shot, setShot] = useState<BrowserScreenshotShot | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [floating, setFloating] = useState(false);
  const floatVersion = useFloatStoreVersion();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the store version signals float closure.
  useEffect(() => {
    if (floating && !isFloatSourceOpen(browserFloatSourceKey(browserSessionId)))
      setFloating(false);
  }, [floating, browserSessionId, floatVersion]);
  const floatAvailable = useFloatHostAvailable();
  const [draft, setDraft] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const record = session.data;
  const generation = record?.generation;
  const navigation = useQuery({
    queryKey: browserPaneKeys.navigation(apiBase, browserSessionId),
    queryFn: ({ signal }) => api.navigation(browserSessionId, signal),
    enabled: record?.state === 'live',
    refetchInterval: 3_000,
    retry: false,
  });
  // Who is driving: the live lease, or an agent that drove within the recent
  // window — the float-over-chat's rule, so both places say the same thing.
  // The payload's arrival on this device's monotonic clock (`dataUpdatedAt`
  // is wall-clock ms at arrival).
  const receivedAt =
    session.dataUpdatedAt > 0
      ? performance.now() - Math.max(0, Date.now() - session.dataUpdatedAt)
      : undefined;
  const driver = useRecentDriver(
    control?.tone ?? null,
    record
      ? agentInputOf(record, receivedAt)
      : {
          lastAgentInputAt: undefined,
          serverNow: undefined,
          receivedAt: undefined,
          lastDriverIsAgent: false,
        },
  );
  const pendingDialog = record?.pendingDialog;
  // #90 D9: while this pane's live view is on screen, the float-over-chat
  // hides for this session (and so never streams it a second time).
  const ownsLiveView = usePaneSourceVisibility(
    !floating &&
      !session.isError &&
      record?.state === 'live' &&
      record.surfaceId
      ? browserShownSourceKey(
          record.browserSessionId,
          apiBase,
          requestScope?.authorityKey,
        )
      : null,
    stageRef,
  );
  // Dialogs the page showed after this pane attached (S6). The first read
  // sets the baseline, so an old dialog is not announced as new.
  const dialogBaseline = useRef<{ seq: number; count: number } | null>(null);
  const lastDialog = record?.activity?.lastDialog;
  const hasRecord = record !== undefined;
  useEffect(() => {
    if (!hasRecord || dialogBaseline.current !== null) return;
    dialogBaseline.current = {
      seq: lastDialog?.seq ?? 0,
      count: lastDialog?.count ?? 0,
    };
  }, [hasRecord, lastDialog]);
  const baseline = dialogBaseline.current;
  // A dismissed notice stays dismissed until a newer dialog (or more repeats
  // of this one) arrives.
  const [dismissedDialog, setDismissedDialog] = useState<{
    seq: number;
    count: number;
  } | null>(null);
  const isDismissed = (dialog: { seq: number; count: number }) =>
    dismissedDialog !== null &&
    dialog.seq === dismissedDialog.seq &&
    dialog.count <= dismissedDialog.count;
  // A newer dialog, or more repeats folded into the one already seen.
  const newDialog =
    lastDialog &&
    baseline &&
    (lastDialog.seq > baseline.seq ||
      (lastDialog.seq === baseline.seq && lastDialog.count > baseline.count))
      ? lastDialog
      : undefined;

  const apply = (next: BrowserSessionView) => {
    queryClient.setQueryData(sessionKey, next);
    void queryClient.invalidateQueries({
      queryKey: browserPaneKeys.sessions(apiBase, projectSlug),
    });
  };
  const navigate = useMutation({
    mutationFn: (url: string) =>
      api.navigate(browserSessionId, browserAddressInput(url), generation),
    onSuccess: (result) => {
      apply(result.session);
      setDraft(null);
      setNotice(
        result.blocked === 'station-listener'
          ? "Station blocked this address: it's one of Station's own services."
          : result.errorText
            ? `The page could not load (${result.errorText}).`
            : null,
      );
    },
    onError: (error, url) => setNotice(describeBrowserFailure(error, url)),
  });
  const history = useMutation({
    mutationFn: (
      action: 'back' | 'forward' | 'reload' | 'hard-reload' | 'stop',
    ) => api.history(browserSessionId, action, generation),
    onSuccess: (next) => {
      apply(next);
      void navigation.refetch();
      setNotice(null);
    },
    onError: (error) => setNotice(describeBrowserFailure(error)),
  });
  /**
   * The page viewport this pane last saw. It is the session's, shared by
   * everyone watching and any agent; a change this pane did not make is said.
   */
  const seenViewport = useRef<string | null>(null);
  const viewport = useMutation({
    mutationFn: (next: BrowserViewportView) =>
      api.viewport(browserSessionId, next, generation),
    onSuccess: (next) => {
      seenViewport.current = viewportKey(next.viewport);
      apply(next);
      setNotice(null);
    },
    onError: (error) => setNotice(describeBrowserFailure(error)),
  });
  const zoom = useMutation({
    mutationFn: (factor: number) =>
      api.zoom(browserSessionId, factor, generation),
    onSuccess: (next) => {
      apply(next);
      setNotice(null);
    },
    onError: (error) => setNotice(describeBrowserFailure(error)),
  });
  const appearance = useMutation({
    mutationFn: (scheme: 'system' | 'light' | 'dark') =>
      api.appearance(browserSessionId, scheme, generation),
    onSuccess: (next) => {
      apply(next);
      setNotice(null);
    },
    onError: (error) => setNotice(describeBrowserFailure(error)),
  });
  const reopen = useMutation({
    mutationFn: () => api.reopen(browserSessionId),
    onSuccess: apply,
    onError: (error) => setNotice(describeBrowserFailure(error)),
  });
  const close = useMutation({
    mutationFn: () => api.close(browserSessionId),
    onSuccess: apply,
    onError: (error) => setNotice(describeBrowserFailure(error)),
  });
  const answerDialog = useMutation({
    mutationFn: (answer: {
      dialogId: string;
      accept: boolean;
      promptText?: string;
    }) => api.answerDialog(browserSessionId, answer),
    onSuccess: (next) => apply(next),
    onError: () => void session.refetch(),
  });
  const screenshot = useMutation({
    mutationFn: async () => ({
      blob: await api.screenshot(browserSessionId),
      host: hostOf(record?.url ?? ''),
      takenAt: new Date(),
      ...(record
        ? {
            provenance: {
              browserSessionId,
              generation: record.generation,
              url: record.url,
            },
          }
        : {}),
    }),
    onSuccess: (next) => {
      setShot(next);
      setNotice(null);
    },
    onError: (error) => setNotice(describeBrowserFailure(error)),
  });
  const screenshotToChat = useMutation({
    mutationFn: async () => {
      const active = navigationStore.getSnapshot().activeChat;
      const matches = Object.entries(activeChatsStore.getSnapshot()).filter(
        ([id, chat]) =>
          (id === active || chat.conversationId === active) &&
          chat.projectSlug === projectSlug,
      );
      if (
        !requestScope ||
        !active ||
        matches.length !== 1 ||
        !requestScope.isCurrent()
      )
        throw new Error(
          'Open a chat in this Project before attaching a screenshot.',
        );
      const sessionId = matches[0]![0];
      const current = () =>
        requestScope.isCurrent() &&
        navigationStore.getSnapshot().activeChat === active &&
        activeChatsStore.getSnapshot()[sessionId]?.projectSlug === projectSlug;
      const blob = await api.screenshot(browserSessionId);
      if (!current())
        throw new Error(
          'The chat or Station changed before the screenshot was attached.',
        );
      const extension = blob.type === 'image/jpeg' ? 'jpg' : 'png';
      const file = new File([blob], `browser-screenshot.${extension}`, {
        type: blob.type,
      });
      const { requestConversationFileIntake } = await import(
        '../../lib/conversation-file-intake'
      );
      return requestConversationFileIntake(
        { ...requestScope, isCurrent: current },
        sessionId,
        [file],
        () => showChatPageOrDock(() => navigationStore.setDockState(true)),
      );
    },
    onSuccess: () => setNotice('Screenshot added to chat.'),
    onError: (error) =>
      setNotice(
        error instanceof BrowserApiError
          ? describeBrowserFailure(error)
          : describeStationFailure(error).body,
      ),
  });
  const openNew = useMutation({
    mutationFn: () => api.create({ projectSlug, url: 'about:blank' }),
    onSuccess: (next) => {
      sizeToOpeningPane.add(next.browserSessionId);
      onAttach(next.browserSessionId);
    },
    onError: (error) => setNotice(describeBrowserFailure(error)),
  });

  const live = record?.state === 'live';
  const recording = useBrowserRecording(
    api,
    browserSessionId,
    generation,
    live && artifactsEnabled && generation !== undefined,
  );
  const consoleState = useBrowserConsole({
    apiBase,
    api,
    browserSessionId,
    live,
    open: panel === 'console',
  });
  const busy = navigate.isPending || history.isPending;
  const canDriveLive = live && canDrive;
  // A page this pane just opened, on a narrow pane: size it to the pane once,
  // so a phone does not start on a desktop page drawn at a quarter scale.
  // Nobody else is watching a session that has only just opened.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per live session; `viewport.mutate` is stable in effect.
  useEffect(() => {
    if (!canDriveLive || !sizeToOpeningPane.has(browserSessionId)) return;
    sizeToOpeningPane.delete(browserSessionId);
    const box = stageRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0 || box.width >= NARROW_PANE_WIDTH) return;
    const fill = viewportToFill(box.width, box.height);
    if (fill) viewport.mutate(fill);
  }, [canDriveLive, browserSessionId]);
  const recordViewport = record ? viewportKey(record.viewport) : null;
  const recordViewportSize = record
    ? `${record.viewport.width} × ${record.viewport.height}`
    : '';
  useEffect(() => {
    if (recordViewport === null) return;
    const previous = seenViewport.current;
    seenViewport.current = recordViewport;
    if (previous !== null && previous !== recordViewport && !viewport.isPending)
      setNotice(
        `The page size changed to ${recordViewportSize} for everyone watching.`,
      );
  }, [recordViewport, recordViewportSize, viewport.isPending]);
  const zoomFactor = record?.zoomFactor ?? 1;
  const canAnnotate = live && !floating && generation !== undefined;
  const canToggleRecording =
    live &&
    generation !== undefined &&
    !recording.busy &&
    !recording.stopping &&
    (recording.active || recording.phase === 'idle');
  const canFloat = live && !!record?.surfaceId && floatAvailable;
  const floatOverChat = () => {
    if (record?.surfaceId)
      requestFloat(
        { kind: 'browser', browserSessionId, surfaceId: record.surfaceId },
        () => setFloating(true),
      );
  };
  const rotateViewport = () => {
    fitToStageRef.current = false;
    if (record)
      viewport.mutate({
        ...record.viewport,
        width: record.viewport.height,
        height: record.viewport.width,
      });
  };
  const openBrowserSettings = () =>
    navigationStore.navigate('/settings', {
      view: 'advanced',
      highlight: 'browser-project-settings',
      project: projectSlug,
    });
  const changeZoom = (direction: -1 | 0 | 1) => {
    if (!canDriveLive || zoom.isPending) return;
    const next =
      direction === 0
        ? 1
        : direction > 0
          ? (BROWSER_ZOOM_STEPS.find((step) => step > zoomFactor + 0.001) ??
            BROWSER_ZOOM_STEPS.at(-1)!)
          : ([...BROWSER_ZOOM_STEPS]
              .reverse()
              .find((step) => step < zoomFactor - 0.001) ??
            BROWSER_ZOOM_STEPS[0]!);
    if (next !== zoomFactor) zoom.mutate(next);
  };
  shortcutActions.current = {
    address: () => addressRef.current?.focus(),
    reload: () => {
      if (canDriveLive && !busy) history.mutate('reload');
    },
    hardReload: () => {
      if (canDriveLive && !busy) history.mutate('hard-reload');
    },
    back: () => {
      if (canDriveLive && !busy && navigation.data?.canGoBack !== false)
        history.mutate('back');
    },
    forward: () => {
      if (canDriveLive && !busy && navigation.data?.canGoForward !== false)
        history.mutate('forward');
    },
    screenshot: () => {
      if (live && !screenshot.isPending) screenshot.mutate();
    },
    screenshotChat: () => {
      if (live && !screenshotToChat.isPending) screenshotToChat.mutate();
    },
    zoomIn: () => changeZoom(1),
    zoomOut: () => changeZoom(-1),
    zoomReset: () => changeZoom(0),
    takeControl: () => {
      if (canDriveLive && control?.tone !== 'you') void control?.claimControl();
    },
    handBack: () => {
      if (canDriveLive && control?.tone === 'you' && !pendingDialog)
        void control.releaseControl();
    },
    annotate: () => {
      if (canAnnotate) setAnnotating(true);
    },
    record: () => {
      if (canToggleRecording) recording.toggle();
    },
    console: () => {
      if (live) togglePanel('console');
    },
    network: () => {
      if (live) togglePanel('network');
    },
    float: () => {
      if (canFloat) floatOverChat();
    },
    rotate: () => {
      if (canDriveLive && !viewport.isPending) rotateViewport();
    },
    stop: () => {
      if (canDriveLive) history.mutate('stop');
    },
    sessions: () => togglePanel('sessions'),
    settings: () => {
      if (canDrive) openBrowserSettings();
    },
  };
  useLayoutEffect(() => {
    if (!shortcutStore || !browserFocused) return;
    setShortcutContext('browserFocused', true);
    // [id, action, key, modifiers, description, disabled, gate]. A keyless
    // entry is a command-palette command; the gate is the Feature Preview
    // its ⋯ row shows under.
    const definitions: Array<
      [
        string,
        string,
        string,
        KeyboardShortcut['modifiers'],
        string,
        boolean,
        boolean?,
      ]
    > = [
      [
        'address',
        'address',
        'l',
        ['cmd'],
        'Focus Browser address',
        !canDriveLive,
      ],
      [
        'reload',
        'reload',
        'r',
        ['cmd'],
        'Reload Browser page',
        !canDriveLive || busy,
      ],
      [
        'hardReload',
        'hardReload',
        'r',
        ['cmd', 'shift'],
        'Reload Browser page without cache',
        !canDriveLive || busy,
      ],
      [
        'backAlt',
        'back',
        'ArrowLeft',
        ['alt'],
        'Browser back',
        !canDriveLive || busy || navigation.data?.canGoBack === false,
      ],
      [
        'forwardAlt',
        'forward',
        'ArrowRight',
        ['alt'],
        'Browser forward',
        !canDriveLive || busy || navigation.data?.canGoForward === false,
      ],
      [
        'back',
        'back',
        '[',
        ['cmd'],
        'Browser back',
        !canDriveLive || busy || navigation.data?.canGoBack === false,
      ],
      [
        'forward',
        'forward',
        ']',
        ['cmd'],
        'Browser forward',
        !canDriveLive || busy || navigation.data?.canGoForward === false,
      ],
      [
        'screenshot',
        'screenshot',
        's',
        ['cmd', 'shift'],
        'Take Browser screenshot',
        !live || screenshot.isPending,
      ],
      [
        'screenshotChat',
        'screenshotChat',
        '',
        [],
        'Screenshot Browser to chat',
        !live || screenshotToChat.isPending,
      ],
      [
        'zoomIn',
        'zoomIn',
        '=',
        ['cmd'],
        'Zoom Browser in',
        !canDriveLive || zoom.isPending,
      ],
      [
        'zoomOut',
        'zoomOut',
        '-',
        ['cmd'],
        'Zoom Browser out',
        !canDriveLive || zoom.isPending,
      ],
      [
        'zoomReset',
        'zoomReset',
        '0',
        ['cmd'],
        'Reset Browser zoom',
        !canDriveLive || zoom.isPending,
      ],
      [
        'takeControl',
        'takeControl',
        '',
        [],
        'Take Browser control',
        !canDriveLive || !control || control.tone === 'you',
      ],
      [
        'handBack',
        'handBack',
        '',
        [],
        'Hand Browser control back',
        !canDriveLive || control?.tone !== 'you' || !!pendingDialog,
      ],
      [
        'annotate',
        'annotate',
        '',
        [],
        'Annotate Browser page',
        !canAnnotate,
        artifactsEnabled,
      ],
      [
        'record',
        'record',
        '',
        [],
        recording.active ? 'Stop Browser recording' : 'Record Browser',
        !canToggleRecording,
        artifactsEnabled,
      ],
      ['console', 'console', '', [], 'Toggle Browser console', !live, true],
      [
        'network',
        'network',
        '',
        [],
        'Toggle Browser network requests',
        !live,
        artifactsEnabled,
      ],
      ['float', 'float', '', [], 'Float Browser over chat', !canFloat],
      [
        'rotate',
        'rotate',
        '',
        [],
        'Rotate Browser viewport',
        !canDriveLive || viewport.isPending,
        true,
      ],
      [
        'stop',
        'stop',
        '',
        [],
        'Stop Browser page loading',
        !canDriveLive,
        true,
      ],
      ['sessions', 'sessions', '', [], 'Toggle Browser sessions', false, true],
      [
        'settings',
        'settings',
        '',
        [],
        'Open Browser settings',
        !canDrive,
        true,
      ],
    ];
    // Keyed shortcuts register always but act only under the experience
    // preview (Screenshot always); a command registers only when its gate is
    // on, defaulting to the experience preview.
    const releases = definitions
      .filter(
        ([id, , key, , , , gate]) =>
          (key !== '' || (gate ?? experienceEnabled)) &&
          !(IS_MAC && (id === 'backAlt' || id === 'forwardAlt')),
      )
      .map(([id, action, key, modifiers, description, disabled, gate]) =>
        shortcutStore.register({
          id: `browser.${id}`,
          key,
          modifiers,
          description,
          disabled: key ? false : disabled,
          when: 'browserFocused',
          handler: () => {
            if (experienceEnabled || id === 'screenshot' || gate !== undefined)
              shortcutActions.current[action]?.();
          },
        }),
      );
    return () => {
      for (const release of releases) release();
      setShortcutContext('browserFocused', false);
    };
  }, [
    shortcutStore,
    browserFocused,
    experienceEnabled,
    artifactsEnabled,
    canAnnotate,
    canToggleRecording,
    canFloat,
    canDrive,
    recording.active,
    viewport.isPending,
    canDriveLive,
    busy,
    live,
    screenshotToChat.isPending,
    screenshot.isPending,
    zoom.isPending,
    control,
    pendingDialog,
    navigation.data?.canGoBack,
    navigation.data?.canGoForward,
  ]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canDrive) return;
    // Put a phone's keyboard away: it covers the page being opened.
    addressRef.current?.blur();
    const value = (draft ?? record?.url ?? '').trim();
    navigate.mutate(value);
  };

  /**
   * The viewport the person chose follows the view's size ("Fit to this
   * pane"), so going full screen or back fits it again; a preset or a
   * rotation is a fixed size and does not.
   */
  const fitToStageRef = useRef(false);
  const fitTo = (stage: Element | null | undefined) => {
    const box = stage?.getBoundingClientRect();
    const fill = box ? viewportToFill(box.width, box.height) : null;
    if (fill) viewport.mutate(fill);
    return fill !== null;
  };
  const onViewport = (id: string) => {
    if (id === 'fill') {
      fitToStageRef.current = true;
      if (!fitTo(stageRef.current))
        setNotice('The pane size could not be measured.');
      return;
    }
    fitToStageRef.current = false;
    const preset = BROWSER_DEVICE_PRESETS.find((p) => p.id === id);
    if (preset) viewport.mutate(preset.viewport);
  };
  const onImmersiveChange = (immersive: boolean) => {
    if (!fitToStageRef.current) return;
    // After the layout settles: full screen measures the live view's own
    // stage (laid over the viewport), the pane its stage as before.
    requestAnimationFrame(() => {
      const stage = immersive
        ? stageRef.current?.querySelector('.live-surface__stage')
        : stageRef.current;
      fitTo(stage);
    });
  };

  const togglePanel = (next: 'sessions' | 'console' | 'network') =>
    setPanel((current) => (current === next ? 'none' : next));

  let body: ReactNode;
  if (session.isPending) {
    body = <SkeletonBlock count={2} label="Loading the browser session" />;
  } else if (session.isError) {
    const gone =
      session.error instanceof BrowserApiError && session.error.status === 404;
    body = gone ? (
      <Empty
        label="This browser session no longer exists"
        description="It may have been closed and cleaned up. Open a new one, or choose another session."
        action={
          canDrive ? (
            <Button
              variant="primary"
              className="browser-pane__control"
              pending={openNew.isPending}
              onClick={() => openNew.mutate()}
            >
              Open a new session
            </Button>
          ) : undefined
        }
      />
    ) : (
      <ErrorState
        title="The browser session could not be read"
        description={describeBrowserFailure(session.error)}
        action={
          <Button
            className="browser-pane__control"
            onClick={() => void session.refetch()}
          >
            Retry
          </Button>
        }
      />
    );
  } else if (record?.state === 'opening') {
    body = <SkeletonBlock count={2} label="Starting the browser" />;
  } else if (record?.state === 'needs-reopen') {
    body = (
      <Empty
        label="The browser stopped"
        description={stoppedReason(record)}
        action={
          canDrive ? (
            <Button
              variant="primary"
              className="browser-pane__control"
              pending={reopen.isPending}
              pendingLabel="Reopening…"
              onClick={() => reopen.mutate()}
            >
              Reopen
            </Button>
          ) : undefined
        }
      />
    );
  } else if (record?.state === 'closed') {
    body = (
      <Empty
        label="This session was closed"
        action={
          canDrive ? (
            <Button
              variant="primary"
              className="browser-pane__control"
              pending={openNew.isPending}
              onClick={() => openNew.mutate()}
            >
              Open a new session
            </Button>
          ) : undefined
        }
      />
    );
  } else if (record && !record.surfaceId) {
    body = (
      <Empty label="The live view isn't available for this session right now" />
    );
  } else if (record?.surfaceId && !ownsLiveView) {
    body = <Empty label="This Browser is shown in another view" />;
  } else if (record?.surfaceId) {
    body = (
      <LiveSurfaceCanvas
        key={record.surfaceId}
        apiBase={apiBase}
        surfaceId={record.surfaceId}
        label={`Browser: ${hostOf(record.url)}`}
        transport={transport}
        // The pane's control line says who drives and offers Take control
        // and the hand-back; the canvas keeps status, notices and input.
        hostControls
        readOnly={!canDrive}
        agentActionsEnabled={experienceEnabled}
        onControlState={setControl}
        fullScreenButton
        onImmersiveChange={onImmersiveChange}
        renderImmersiveActions={() => (
          <BrowserImmersiveNav
            part="address"
            host={hostOf(record.url)}
            disabled={!canDriveLive || history.isPending}
            onAction={(action) => history.mutate(action)}
          />
        )}
        renderImmersiveMenu={() => (
          <BrowserImmersiveNav
            part="navigation"
            host={hostOf(record.url)}
            disabled={!canDriveLive || history.isPending}
            onAction={(action) => history.mutate(action)}
          />
        )}
        // Drawn by the live view, so it stays over the page in full screen.
        overlay={
          canDriveLive && pendingDialog ? (
            // Over the live view: the page is waiting on this answer.
            <div className="browser-pane__dialog-layer">
              <BrowserPageDialog
                key={pendingDialog.dialogId}
                dialog={pendingDialog}
                pageHost={hostOf(record?.url ?? '')}
                pending={answerDialog.isPending}
                error={
                  answerDialog.isError
                    ? describeBrowserFailure(answerDialog.error)
                    : null
                }
                onAnswer={(answer) =>
                  answerDialog.mutate({
                    dialogId: pendingDialog.dialogId,
                    ...answer,
                  })
                }
                {...(control?.tone === 'you'
                  ? { onKeepAlive: () => void control.keepControlAlive() }
                  : {})}
              />
            </div>
          ) : null
        }
      />
    );
  }

  const handBackLabel = record?.activity.agentDriven
    ? 'Hand back to agent'
    : 'Release control';
  const currentPreset = record ? presetFor(record.viewport) : undefined;
  const viewportValue = record
    ? currentPreset
      ? currentPreset.label.replace(/\s+\d+\s*×\s*\d+$/, '')
      : `${record.viewport.width} × ${record.viewport.height}`
    : '';
  const errors = consoleState.unreadErrors;
  // A finger has no chord to press: on a coarse primary pointer the menu
  // shows no keyboard hint (the composer menu's rule). Accepted limit: a
  // touch-first tablet with a hardware keyboard loses the hint too.
  const shortcutHint = (shortcut: { label: string; aria: string }) =>
    coarsePointer ? {} : { hint: shortcut.label, hintKeys: shortcut.aria };
  const menuItems: PaneMenuItem[] = [
    { kind: 'heading', id: 'capture', label: 'Capture' },
    {
      kind: 'action',
      id: 'screenshot',
      label: 'Screenshot',
      glyph: <CameraGlyph />,
      ...shortcutHint(SCREENSHOT_SHORTCUT),
      disabled: !live || screenshot.isPending,
      onSelect: () => screenshot.mutate(),
    },
    ...(artifactsEnabled
      ? [
          {
            kind: 'action' as const,
            id: 'annotate',
            label: 'Annotate',
            glyph: <EditGlyph />,
            disabled: !canAnnotate,
            onSelect: () => setAnnotating(true),
          },
          {
            kind: 'action' as const,
            id: 'record',
            label: recording.active ? 'Stop recording' : 'Record',
            glyph: <RecordGlyph />,
            disabled: !canToggleRecording,
            onSelect: recording.toggle,
          },
        ]
      : []),
    // Zoom, appearance and viewport are the page's, not this pane's: one
    // page is streamed to every viewer and read by agents. Each viewer's own
    // fit and pinch zoom live in the live view and change nothing shared.
    { kind: 'heading', id: 'view', label: 'View for everyone watching' },
    ...(experienceEnabled
      ? [
          {
            kind: 'list' as const,
            id: 'zoom',
            label: 'Zoom',
            glyph: <SearchGlyph />,
            hint: `${Math.round(zoomFactor * 100)}%`,
            disabled: !canDriveLive || zoom.isPending,
            choices: BROWSER_ZOOM_STEPS.map((factor) => ({
              id: String(factor),
              label: `${Math.round(factor * 100)}%`,
              checked: Math.abs(factor - zoomFactor) < 0.001,
              onSelect: () => zoom.mutate(factor),
            })),
          },
          {
            kind: 'list' as const,
            id: 'appearance',
            label: 'Appearance',
            glyph: <MoonGlyph />,
            hint: record?.colorScheme ?? 'system',
            disabled: !canDriveLive || appearance.isPending,
            choices: (['system', 'light', 'dark'] as const).map((scheme) => ({
              id: scheme,
              label: scheme[0]!.toUpperCase() + scheme.slice(1),
              checked: (record?.colorScheme ?? 'system') === scheme,
              onSelect: () => appearance.mutate(scheme),
            })),
          },
        ]
      : []),
    {
      kind: 'list',
      id: 'viewport',
      label: 'Viewport',
      glyph: <PhoneGlyph />,
      hint: viewportValue,
      disabled: !canDriveLive || viewport.isPending,
      choices: [
        {
          id: 'fill',
          label: 'Match this pane',
          checked: false,
          onSelect: () => onViewport('fill'),
        },
        ...BROWSER_DEVICE_PRESETS.map((preset) => ({
          id: preset.id,
          label: preset.label,
          checked: currentPreset?.id === preset.id,
          onSelect: () => onViewport(preset.id),
        })),
      ],
    },
    {
      kind: 'action',
      id: 'rotate',
      label: 'Rotate viewport',
      glyph: <RotateGlyph />,
      disabled: !canDriveLive || viewport.isPending,
      onSelect: rotateViewport,
    },
    { kind: 'heading', id: 'inspect', label: 'Inspect' },
    {
      kind: 'action',
      id: 'console',
      label: panel === 'console' ? 'Hide console' : 'Console',
      glyph: <TerminalGlyph />,
      hint: errors > 0 ? `${errors > 9 ? '9+' : errors} new` : undefined,
      disabled: !live,
      onSelect: () => togglePanel('console'),
    },
    ...(artifactsEnabled
      ? [
          {
            kind: 'action' as const,
            id: 'network',
            label: panel === 'network' ? 'Hide network' : 'Network',
            glyph: <GlobeGlyph />,
            disabled: !live,
            onSelect: () => togglePanel('network'),
          },
        ]
      : []),
    { kind: 'heading', id: 'session', label: 'Session' },
    ...(experienceEnabled
      ? [
          {
            kind: 'action' as const,
            id: 'float',
            label: floatAvailable
              ? 'Float over chat'
              : 'Float over chat (open a chat first)',
            glyph: <MessageGlyph />,
            disabled: !canFloat,
            onSelect: floatOverChat,
          },
        ]
      : []),
    {
      kind: 'action',
      id: 'hard-reload',
      label: 'Reload without cache',
      glyph: <RefreshGlyph />,
      ...shortcutHint(HARD_RELOAD_SHORTCUT),
      disabled: !canDriveLive || busy,
      onSelect: () => history.mutate('hard-reload'),
    },
    {
      kind: 'action',
      id: 'stop',
      label: 'Stop loading',
      glyph: <PauseGlyph />,
      disabled: !canDriveLive,
      onSelect: () => history.mutate('stop'),
    },
    {
      kind: 'action',
      id: 'sessions',
      label: 'Sessions',
      glyph: <BoardGlyph />,
      onSelect: () => togglePanel('sessions'),
    },
    {
      kind: 'action',
      id: 'settings',
      label: 'Browser settings…',
      glyph: <SettingsGlyph />,
      disabled: !canDrive,
      onSelect: openBrowserSettings,
    },
    ...(canDriveLive
      ? [
          // The destructive row stands alone, last, in a group of its own.
          { kind: 'heading' as const, id: 'end', label: '' },
          {
            kind: 'danger' as const,
            id: 'close',
            label: 'Close session',
            glyph: <CloseGlyph />,
            disabled: close.isPending,
            onSelect: () => close.mutate(),
          },
        ]
      : []),
  ];
  const blank = record?.url === 'about:blank';
  const parts = addressParts(blank ? '' : (record?.url ?? ''));
  const editing = addressFocused || draft !== null;
  // One word, and only when it says something: a live control or an agent's
  // recent drive. Nobody in control needs no chip.
  const chipTone = live && control ? driver : 'none';

  return (
    <div
      className="browser-pane"
      data-coarse={coarsePointer || undefined}
      data-narrow={narrow || undefined}
      ref={paneRef}
    >
      <form
        className="browser-pane__toolbar"
        onSubmit={onSubmit}
        aria-label="Browser toolbar"
      >
        <div
          className={`browser-pane__omni${editing ? ' browser-pane__omni--editing' : ''}${addressFocused ? ' browser-pane__omni--focused' : ''}`}
        >
          <span
            className="browser-pane__omni-lock"
            title={parts.secure ? 'Secure connection (https)' : undefined}
            aria-hidden="true"
          >
            {parts.secure ? <LockGlyph /> : <GlobeGlyph />}
          </span>
          <span className="browser-pane__omni-field">
            <input
              ref={addressRef}
              className="browser-pane__omni-input"
              aria-label="Address"
              title={record?.url}
              value={draft ?? (blank ? '' : (record?.url ?? ''))}
              placeholder="Search or enter an address"
              onChange={(event) => setDraft(event.target.value)}
              onFocus={(event) => {
                setAddressFocused(true);
                const input = event.currentTarget;
                requestAnimationFrame(() => input.select());
              }}
              onBlur={() => setAddressFocused(false)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setDraft(null);
                  event.currentTarget.blur();
                }
              }}
              disabled={!canDriveLive}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
              enterKeyHint="go"
              aria-busy={navigate.isPending || undefined}
            />
            {editing ? null : (
              <span className="browser-pane__omni-display" aria-hidden="true">
                <span className="browser-pane__omni-host">{parts.host}</span>
                <span className="browser-pane__omni-path">{parts.path}</span>
              </span>
            )}
          </span>
          <IconButton
            className="browser-pane__omni-reveal browser-pane__nav-action"
            aria-label="Back"
            title="Back"
            disabled={
              !canDriveLive ||
              busy ||
              (navigation.data?.generation === generation &&
                navigation.data?.canGoBack === false)
            }
            onClick={() => history.mutate('back')}
          >
            <ArrowLeftGlyph />
          </IconButton>
          <IconButton
            className="browser-pane__omni-reveal browser-pane__nav-action"
            aria-label="Forward"
            title="Forward"
            disabled={
              !canDriveLive ||
              busy ||
              (navigation.data?.generation === generation &&
                navigation.data?.canGoForward === false)
            }
            onClick={() => history.mutate('forward')}
          >
            <ArrowRightGlyph />
          </IconButton>
          <IconButton
            className="browser-pane__nav-action"
            aria-label="Reload"
            title="Reload"
            disabled={!canDriveLive || busy}
            onClick={() => history.mutate('reload')}
          >
            <RefreshGlyph />
          </IconButton>
        </div>
        <BrowserDriverChip
          tone={chipTone}
          api={api}
          apiBase={apiBase}
          browserSessionId={browserSessionId}
          canRelease={canDriveLive && control?.tone === 'you'}
          releaseLabel={handBackLabel}
          releaseBlocked={pendingDialog !== undefined}
          onRelease={() => void control?.releaseControl()}
        />
        <PaneOverflowMenu
          label={
            errors > 0
              ? `More browser actions, ${errors} new console ${errors === 1 ? 'error' : 'errors'}`
              : 'More browser actions'
          }
          items={menuItems}
        >
          <MoreGlyph />
          {errors > 0 ? (
            <span className="browser-pane__badge-dot" aria-hidden="true" />
          ) : null}
        </PaneOverflowMenu>
      </form>
      {!canDrive ? <p className="browser-pane__hint">View only</p> : null}
      {panel === 'console' ? (
        <BrowserConsoleDrawer read={consoleState.read} live={live} />
      ) : null}
      {panel === 'network' && artifactsEnabled ? (
        <BrowserNetworkDrawer
          api={api}
          apiBase={apiBase}
          browserSessionId={browserSessionId}
          generation={generation ?? 0}
          live={live}
        />
      ) : null}
      {panel === 'sessions' ? (
        <BrowserSessionList
          apiBase={apiBase}
          api={api}
          projectSlug={projectSlug}
          currentSessionId={browserSessionId}
          onOpen={(id) => {
            setPanel('none');
            onAttach(id);
          }}
        />
      ) : null}
      <div className="browser-pane__stage" ref={stageRef}>
        {floating ? (
          <Empty
            label="This Browser is floating over chat"
            action={
              <Button onClick={() => setFloating(false)}>Return to pane</Button>
            }
          />
        ) : (
          body
        )}
        {experienceEnabled && live && !floating && zoomFactor !== 1 ? (
          <output
            className="browser-pane__zoom-indicator"
            aria-label={`Page zoom ${Math.round(zoomFactor * 100)}%`}
          >
            {Math.round(zoomFactor * 100)}%
          </output>
        ) : null}
        {annotating &&
        live &&
        !floating &&
        record &&
        generation !== undefined ? (
          <BrowserAnnotationFlow
            key={`${browserSessionId}:${generation}:${record.url}:${record.viewport.width}:${record.viewport.height}:${record.zoomFactor ?? 1}`}
            stageRef={stageRef}
            record={record}
            api={api}
            onClose={() => setAnnotating(false)}
            onError={setNotice}
          />
        ) : null}
        {canDriveLive && record?.surfaceId && chipTone === 'agent' ? (
          <span className="browser-pane__takeover-hint" aria-hidden="true">
            {coarsePointer ? 'Tap' : 'Click'} anywhere to take over from the
            agent
          </span>
        ) : null}
        {notice ||
        shot ||
        (artifactsEnabled && (recording.phase !== 'idle' || recording.error)) ||
        (newDialog && !isDismissed(newDialog)) ? (
          // Laid over the live view, never above it: a notice appearing must
          // not move the canvas under someone's pointer.
          <div className="browser-pane__notices">
            {artifactsEnabled ? (
              <BrowserRecordingStatus recording={recording} />
            ) : null}
            {notice ? (
              <div className="browser-pane__overlay-notice">
                <p className="browser-pane__notice" role="alert">
                  {notice}
                </p>
                <Button
                  size="sm"
                  className="browser-pane__control"
                  onClick={() => setNotice(null)}
                >
                  Dismiss message
                </Button>
              </div>
            ) : null}
            {shot ? (
              <BrowserScreenshot
                shot={shot}
                onDismiss={() => setShot(null)}
                onAttach={
                  artifactsEnabled
                    ? () => {
                        void Promise.resolve()
                          .then(async () => {
                            const attach = attachFiles();
                            const provenance = shot.provenance;
                            if (!provenance)
                              throw new Error(
                                'Screenshot provenance is unavailable.',
                              );
                            const current = await api.sessionSummary(
                              provenance.browserSessionId,
                            );
                            if (
                              current.state !== 'live' ||
                              current.generation !== provenance.generation ||
                              current.url !== provenance.url
                            )
                              throw new StationUiError(
                                'The browser changed before the screenshot could be attached.',
                              );
                            return attach([
                              new File(
                                [shot.blob],
                                `browser-screenshot.${shot.blob.type === 'image/jpeg' ? 'jpg' : 'png'}`,
                                { type: shot.blob.type },
                              ),
                              new File(
                                [
                                  JSON.stringify(
                                    {
                                      kind: 'browser-screenshot',
                                      observedAt: shot.takenAt.toISOString(),
                                      browserSessionId:
                                        provenance.browserSessionId,
                                      generation: provenance.generation,
                                      untrustedPageContent: {
                                        notice: BROWSER_PAGE_CONTENT_NOTICE,
                                        url: provenance.url,
                                      },
                                    },
                                    null,
                                    2,
                                  ),
                                ],
                                'browser-screenshot.json',
                                { type: 'application/json' },
                              ),
                            ]);
                          })
                          .then(
                            () => setShot(null),
                            (error) =>
                              setNotice(describeStationFailure(error).body),
                          );
                      }
                    : undefined
                }
              />
            ) : null}
            {newDialog && !isDismissed(newDialog) ? (
              <div className="browser-pane__overlay-notice" role="status">
                <p className="browser-pane__notice">
                  {`The page showed a dialog${newDialog.message ? `: “${newDialog.message}”` : ''}. Station ${newDialog.accepted ? 'accepted' : 'dismissed'} it automatically${newDialog.count > 1 ? ` (${newDialog.count} times)` : ''}${newDialog.unanswered ? ' because nobody answered it in time' : newDialog.controlEnded ? ' because your control ended before it was answered' : ' because no person was in control'}. Take control before the page asks, and you can answer it yourself.`}
                </p>
                <Button
                  size="sm"
                  className="browser-pane__control"
                  onClick={() =>
                    setDismissedDialog({
                      seq: newDialog.seq,
                      count: newDialog.count,
                    })
                  }
                >
                  Dismiss
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Why Open failed, with the guide link when there is a fix to follow. The
 * link is its own 44px row under the reason, not a word-sized inline target.
 */
export function BrowserOpenFailureNotice(props: {
  error: unknown;
  typed?: string;
}) {
  const help = browserFailureHelpUrl(props.error);
  return (
    <p className="browser-pane__notice" role="alert">
      {describeBrowserFailure(props.error, props.typed)}
      {help ? (
        <>
          {' '}
          <a
            className="browser-pane__notice-help"
            href={help}
            target="_blank"
            rel="noopener noreferrer"
          >
            How to fix
          </a>
        </>
      ) : null}
    </p>
  );
}
