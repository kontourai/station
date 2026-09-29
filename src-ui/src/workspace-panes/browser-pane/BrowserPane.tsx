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
  useRef,
  useState,
} from 'react';
import { Button } from '../../components/Button';
import { ArrowDownGlyph } from '../../components/icons/Glyph';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { browserFloatSourceKey } from '../../float-over-chat/floatSource';
import {
  agentInputOf,
  DRIVER_TEXT,
  useRecentDriver,
} from '../../float-over-chat/recentDriver';
import { useAnnounceShownSource } from '../../float-over-chat/shownSources';
import {
  LiveSurfaceCanvas,
  type LiveSurfaceControlState,
} from '../../live-surface/LiveSurfaceCanvas';
import { BrowserAcquisitionPanel } from './BrowserAcquisitionPanel';
import { BrowserAgentSettingsPanel } from './BrowserAgentSettingsPanel';
import { BrowserConsoleDrawer } from './BrowserConsoleDrawer';
import { BrowserLocalTargetsPanel } from './BrowserLocalTargetsPanel';
import { BrowserPageDialog } from './BrowserPageDialog';
import {
  BrowserScreenshot,
  type BrowserScreenshotShot,
} from './BrowserScreenshot';
import { BrowserSessionList } from './BrowserSessionList';
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
  browserPaneApi,
  browserPaneKeys,
  describeBrowserFailure,
} from './browserPaneApi';
import './BrowserPane.css';

/**
 * Browser pane v2 (#90): a server-side Chromium page, streamed live
 * (`LiveSurfaceCanvas`) and driven from here. The session is SERVER-owned;
 * this pane only remembers which one it shows on this device.
 *
 * Every state is said as it is: unavailable on a hosted Station, refused to
 * a caller who is not the operator or a Project admin, waiting on the
 * operator's consent to download Chromium, a browser that stopped and needs
 * reopening, a session that no longer exists. The pane's control line says
 * who is driving (the same rule and words as the float-over-chat), offers
 * Take control, and — when this person holds control — hands it back.
 *
 * Page tools: a dialog the page shows while this person is in control waits
 * for their answer here; the console drawer reads the page's console; a
 * screenshot can be saved or copied. On a narrow pane the secondary controls
 * fold behind More, and every control keeps a 44px target.
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
  /** Test seam; defaults to the SDK's `authenticatedFetch`. */
  transport?: BrowserFetch;
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
  transport = authenticatedFetch,
}: BrowserPaneProps) {
  const { apiBase } = useApiBase();
  const api = browserPaneApi(apiBase, transport);
  const queryClient = useQueryClient();
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
        ) : status === 403 ? (
          <Empty
            label="The browser isn't available to you"
            description="Only the Station operator and this Project's admins can open or watch its browser sessions."
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
                Try again
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
        />
      </div>
    );
  if (target.kind === 'migrate')
    return (
      <div className="browser-pane">
        <BrowserMigration
          api={api}
          projectSlug={projectSlug}
          migration={target.migration}
          onAttach={onAttach}
        />
      </div>
    );
  return (
    <BrowserSessionPane
      key={target.browserSessionId}
      apiBase={apiBase}
      api={api}
      projectSlug={projectSlug}
      browserSessionId={target.browserSessionId}
      operator={access.data.operator}
      onAttach={onAttach}
      transport={transport}
    />
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
            Try again
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

/** A pane with no session yet: open a page, or attach to an existing one. */
function BrowserNewSession({
  apiBase,
  api,
  projectSlug,
  onAttach,
}: {
  apiBase: string;
  api: BrowserPaneApi;
  projectSlug: string;
  onAttach: (browserSessionId: string) => void;
}) {
  const [address, setAddress] = useState('');
  const open = useMutation({
    mutationFn: (url: string) => api.create({ projectSlug, url }),
    onSuccess: (session) => onAttach(session.browserSessionId),
  });
  return (
    <>
      <form
        className="browser-pane__nav"
        aria-label="Open a page"
        onSubmit={(event) => {
          event.preventDefault();
          open.mutate(address.trim() || 'about:blank');
        }}
      >
        <input
          className="browser-pane__address"
          aria-label="Address"
          placeholder="https://example.com"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
        />
        <Button
          type="submit"
          variant="primary"
          className="browser-pane__control"
          pending={open.isPending}
        >
          Open
        </Button>
      </form>
      {open.isError ? (
        <p className="browser-pane__notice" role="alert">
          {describeBrowserFailure(open.error, address)}
        </p>
      ) : null}
      <BrowserSessionList
        apiBase={apiBase}
        api={api}
        projectSlug={projectSlug}
        onOpen={onAttach}
      />
    </>
  );
}

function BrowserSessionPane({
  apiBase,
  api,
  projectSlug,
  browserSessionId,
  operator,
  onAttach,
  transport,
}: {
  apiBase: string;
  api: BrowserPaneApi;
  projectSlug: string;
  browserSessionId: string;
  operator: boolean;
  onAttach: (browserSessionId: string) => void;
  transport: BrowserFetch;
}) {
  const queryClient = useQueryClient();
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
    'none' | 'sessions' | 'targets' | 'agents' | 'console'
  >('none');
  /** Narrow panes fold the secondary controls behind More. */
  const [moreOpen, setMoreOpen] = useState(false);
  const [shot, setShot] = useState<BrowserScreenshotShot | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const record = session.data;
  const generation = record?.generation;
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
  useAnnounceShownSource(
    !session.isError && record?.state === 'live' && record.surfaceId
      ? browserFloatSourceKey(record.browserSessionId)
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
      api.navigate(browserSessionId, url, generation),
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
    mutationFn: (action: 'back' | 'forward' | 'reload') =>
      api.history(browserSessionId, action, generation),
    onSuccess: (next) => {
      apply(next);
      setNotice(null);
    },
    onError: (error) => setNotice(describeBrowserFailure(error)),
  });
  const viewport = useMutation({
    mutationFn: (next: BrowserViewportView) =>
      api.viewport(browserSessionId, next, generation),
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
    }),
    onSuccess: (next) => {
      setShot(next);
      setNotice(null);
    },
    onError: (error) => setNotice(describeBrowserFailure(error)),
  });
  const openNew = useMutation({
    mutationFn: () => api.create({ projectSlug, url: 'about:blank' }),
    onSuccess: (next) => onAttach(next.browserSessionId),
    onError: (error) => setNotice(describeBrowserFailure(error)),
  });

  const live = record?.state === 'live';
  const busy = navigate.isPending || history.isPending;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = (draft ?? record?.url ?? '').trim();
    navigate.mutate(value);
  };

  const onViewport = (id: string) => {
    if (id === 'fill') {
      const box = stageRef.current?.getBoundingClientRect();
      const fill = box ? viewportToFill(box.width, box.height) : null;
      if (fill) viewport.mutate(fill);
      else setNotice('The pane size could not be measured.');
      return;
    }
    const preset = BROWSER_DEVICE_PRESETS.find((p) => p.id === id);
    if (preset) viewport.mutate(preset.viewport);
  };

  const togglePanel = (next: 'sessions' | 'targets' | 'agents' | 'console') =>
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
          <Button
            variant="primary"
            className="browser-pane__control"
            pending={openNew.isPending}
            onClick={() => openNew.mutate()}
          >
            Open a new session
          </Button>
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
            Try again
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
          <Button
            variant="primary"
            className="browser-pane__control"
            pending={reopen.isPending}
            pendingLabel="Reopening…"
            onClick={() => reopen.mutate()}
          >
            Reopen
          </Button>
        }
      />
    );
  } else if (record?.state === 'closed') {
    body = (
      <Empty
        label="This session was closed"
        action={
          <Button
            variant="primary"
            className="browser-pane__control"
            pending={openNew.isPending}
            onClick={() => openNew.mutate()}
          >
            Open a new session
          </Button>
        }
      />
    );
  } else if (record && !record.surfaceId) {
    body = (
      <Empty label="The live view isn't available for this session right now" />
    );
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
        onControlState={setControl}
      />
    );
  }

  const selectedViewport = record
    ? (presetFor(record.viewport)?.id ?? 'session')
    : 'session';

  return (
    <div className="browser-pane">
      <form
        className="browser-pane__nav"
        onSubmit={onSubmit}
        aria-label="Browser address"
      >
        <Button
          type="button"
          className="browser-pane__control"
          aria-label="Back"
          disabled={!live || busy}
          onClick={() => history.mutate('back')}
        >
          ‹
        </Button>
        <Button
          type="button"
          className="browser-pane__control"
          aria-label="Forward"
          disabled={!live || busy}
          onClick={() => history.mutate('forward')}
        >
          ›
        </Button>
        <Button
          type="button"
          className="browser-pane__control"
          aria-label="Reload"
          disabled={!live || busy}
          onClick={() => history.mutate('reload')}
        >
          ↻
        </Button>
        <input
          className="browser-pane__address"
          aria-label="Address"
          value={draft ?? record?.url ?? ''}
          onChange={(event) => setDraft(event.target.value)}
          disabled={!live}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
        />
        <Button
          type="submit"
          variant="primary"
          className="browser-pane__control"
          disabled={!live}
          pending={navigate.isPending}
        >
          Go
        </Button>
      </form>
      <div className="browser-pane__bar">
        <div className="browser-pane__driving">
          <p
            className="browser-pane__driver"
            data-tone={driver}
            aria-live="polite"
          >
            {live && control ? DRIVER_TEXT[driver] : live ? 'Connecting…' : ''}
          </p>
          {live && control?.status === 'live' && control.tone !== 'you' ? (
            <Button
              size="sm"
              className="browser-pane__control"
              onClick={() => void control.claimControl()}
            >
              Take control
            </Button>
          ) : null}
          {live && control?.tone === 'you' ? (
            <Button
              size="sm"
              className="browser-pane__control"
              disabled={pendingDialog !== undefined}
              title={
                pendingDialog
                  ? 'Answer the page’s dialog first.'
                  : record?.activity.agentDriven
                    ? 'Let an agent drive again now, without waiting for your control to lapse.'
                    : 'Stop controlling the page.'
              }
              onClick={() => void control.releaseControl()}
            >
              {record?.activity.agentDriven
                ? 'Hand back to agent'
                : 'Release control'}
            </Button>
          ) : null}
        </div>
        <div className="browser-pane__tools">
          <Button
            size="sm"
            className="browser-pane__control"
            aria-expanded={panel === 'console'}
            disabled={!live}
            onClick={() => togglePanel('console')}
          >
            Console
          </Button>
          <Button
            size="sm"
            className="browser-pane__control"
            disabled={!live}
            pending={screenshot.isPending}
            onClick={() => screenshot.mutate()}
          >
            Screenshot
          </Button>
          <Button
            size="sm"
            className="browser-pane__control browser-pane__more"
            aria-expanded={moreOpen}
            aria-controls={`${browserSessionId}-more`}
            onClick={() => setMoreOpen((open) => !open)}
          >
            More
          </Button>
        </div>
        <div
          id={`${browserSessionId}-more`}
          className={`browser-pane__secondary${moreOpen ? ' browser-pane__secondary--open' : ''}`}
        >
          <label className="browser-pane__viewport">
            <span>Viewport</span>
            <select
              className="choice-trigger browser-pane__select"
              value={selectedViewport}
              disabled={!live || viewport.isPending}
              onChange={(event) => onViewport(event.target.value)}
            >
              {selectedViewport === 'session' && record ? (
                <option value="session">
                  {`${record.viewport.width} × ${record.viewport.height}`}
                </option>
              ) : null}
              <option value="fill">Fit to this pane</option>
              {BROWSER_DEVICE_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
            </select>
            <ArrowDownGlyph className="choice-caret browser-pane__caret" />
          </label>
          <Button
            size="sm"
            className="browser-pane__control"
            aria-expanded={panel === 'sessions'}
            onClick={() => togglePanel('sessions')}
          >
            Sessions
          </Button>
          <Button
            size="sm"
            className="browser-pane__control"
            aria-expanded={panel === 'agents'}
            onClick={() => togglePanel('agents')}
          >
            Agent access
          </Button>
          {operator ? (
            <Button
              size="sm"
              className="browser-pane__control"
              aria-expanded={panel === 'targets'}
              onClick={() => togglePanel('targets')}
            >
              Local servers
            </Button>
          ) : null}
          {live ? (
            <Button
              size="sm"
              variant="danger-outline"
              className="browser-pane__control"
              pending={close.isPending}
              onClick={() => close.mutate()}
            >
              Close session
            </Button>
          ) : null}
        </div>
      </div>
      {panel === 'console' ? (
        <BrowserConsoleDrawer
          apiBase={apiBase}
          api={api}
          browserSessionId={browserSessionId}
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
      {panel === 'agents' ? (
        <BrowserAgentSettingsPanel
          apiBase={apiBase}
          api={api}
          projectSlug={projectSlug}
        />
      ) : null}
      {panel === 'targets' && operator ? (
        <BrowserLocalTargetsPanel
          apiBase={apiBase}
          api={api}
          projectSlug={projectSlug}
        />
      ) : null}
      <div className="browser-pane__stage" ref={stageRef}>
        {body}
        {live && pendingDialog ? (
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
            />
          </div>
        ) : null}
        {notice || shot || (newDialog && !isDismissed(newDialog)) ? (
          // Laid over the live view, never above it: a notice appearing must
          // not move the canvas under someone's pointer.
          <div className="browser-pane__notices">
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
              <BrowserScreenshot shot={shot} onDismiss={() => setShot(null)} />
            ) : null}
            {newDialog && !isDismissed(newDialog) ? (
              <div className="browser-pane__overlay-notice" role="status">
                <p className="browser-pane__notice">
                  {`The page showed a dialog${newDialog.message ? `: “${newDialog.message}”` : ''}. Station ${newDialog.accepted ? 'accepted' : 'dismissed'} it automatically${newDialog.count > 1 ? ` (${newDialog.count} times)` : ''}${newDialog.unanswered ? ' because nobody answered it in time' : ' because no person was in control'}. Take control before the page asks, and you can answer it yourself.`}
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
