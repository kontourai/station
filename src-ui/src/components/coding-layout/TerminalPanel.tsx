import type { TerminalLaunchProfile } from '@kontourai/station-contracts/terminal-transport';
import {
  authenticatedFetch,
  executeCodingCommand,
  type TerminalSession,
  type TerminalSessionTarget,
} from '@kontourai/station-sdk';
import {
  type TerminalLinkTarget,
  TerminalView,
  type TerminalViewSession,
  toTerminalViewSession,
} from '@kontourai/station-sdk/terminal-view';
import { useEffect, useRef, useState } from 'react';
import {
  activeChatsStore,
  useActiveChatActions,
} from '../../contexts/ActiveChatsContext';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { setShortcutContext } from '../../contexts/KeyboardShortcutsContext';
import { useNavigation } from '../../contexts/NavigationContext';
import {
  describeOpenInRegionRefusal,
  useOpenBrowserSessionInRegion,
  useOpenFilePreviewInRegion,
} from '../../contexts/useOpenInRegion';
import { MOBILE_MEDIA_QUERY, useIsMobile } from '../../hooks/useIsMobile';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import { browserPaneApi } from '../../workspace-panes/browser-pane/browserPaneApi';
import { activeTerminalWriter } from './activeTerminal';
import { terminalLinkRelativePath } from './terminalLinkPath';
import {
  buildTerminalSelectionHandoff,
  selectionContainsCredential,
} from './terminalSelectionHandoff';
import { useTerminalSessionStore } from './terminalSessionStore';

/**
 * One terminal view on the shared SDK session store: the same-origin socket
 * every operator device reaches (#3994). The server decides the program and
 * working directory; this view names a session, or asks for a new one. It
 * renders through the public `TerminalView`, the surface plugins also get.
 */
export function TerminalPanel({
  projectSlug,
  workingDir,
  target,
  terminalId,
  viewKey,
  launch,
  legacyTerminalId,
  onOpened,
  isActive = false,
  attachOnly = false,
  readOnly = false,
}: {
  projectSlug: string;
  workingDir: string;
  /** The session scope; absent while the Project is still loading. */
  target: TerminalSessionTarget | undefined;
  /** An existing session to attach to. */
  terminalId?: string;
  /** Stable identity of this view (a tab id); a change starts a new view. */
  viewKey?: string;
  /** For a new session: a server-resolved program by name. */
  launch?: TerminalLaunchProfile;
  /** For a new session: import this pre-socket terminal's history once. */
  legacyTerminalId?: string;
  /** The server accepted a new session under this id. */
  onOpened?: (terminalId: string) => void;
  /** Join a session the server started; never start a shell in its place. */
  attachOnly?: boolean;
  /** Watch without typing, pasting or resizing, whatever the session allows. */
  readOnly?: boolean;
  /** True when this is the visible terminal tab; only then does it accept
   * externally-injected input (e.g. "Send to terminal" from the file tree). */
  isActive?: boolean;
}) {
  const store = useTerminalSessionStore();
  const { apiBase } = useApiBase();
  const openFilePreview = useOpenFilePreviewInRegion();
  const openBrowserSession = useOpenBrowserSessionInRegion();
  const activeChat = useNavigation((state) => state.activeChat);
  const { getDraft, setDraft, updateChat } = useActiveChatActions();
  const sessionRef = useRef<TerminalSession | null>(null);
  const [viewSession, setViewSession] = useState<TerminalViewSession | null>(
    null,
  );
  const [wsError, setWsError] = useState<string | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [connected, setConnected] = useState(false);
  const isMobile = useIsMobile();
  // #1244: the server's specific degraded-terminal reason (node-pty failed
  // to load). Distinct from wsError so a dead PTY backend reads as "here is
  // why, and what still works", never as a silent pane or a transport blip.
  const [unavailableReason, setUnavailableReason] = useState<string | null>(
    null,
  );
  const [handoffError, setHandoffError] = useState<string | null>(null);
  // The newest open options; a view does not restart when they change.
  const intentRef = useRef({ terminalId, launch, legacyTerminalId, onOpened });
  intentRef.current = { terminalId, launch, legacyTerminalId, onOpened };
  const projectId = target?.projectId;
  const bindingKey = target?.bindingKey;
  const key = viewKey ?? terminalId;
  // Larger glyphs on a phone, by the app's one mobile breakpoint (including
  // its landscape-phone clause). Read once per view, as before.
  const [fontSize] = useState(() =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(MOBILE_MEDIA_QUERY).matches
      ? 14
      : 12,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit reconnect restarts this view with the same terminal identity.
  useEffect(() => {
    if (!projectId || !bindingKey) return;
    setUnavailableReason(null);
    setWsError(null);
    setConnected(false);

    const scope = { projectId, bindingKey };
    const intent = intentRef.current;
    if (store.failure) store.restart();
    let session: TerminalSession | null = null;
    let unsubscribe: (() => void) | undefined;
    let reported = intent.terminalId;
    const begin = (importHistory: boolean) => {
      unsubscribe?.();
      // The view sizes the session once it has measured its grid; the store
      // sends the latest size when the session is ready.
      session = intent.terminalId
        ? store.attach(scope, intent.terminalId)
        : attachOnly
          ? null
          : store.open(scope, {
              cols: 80,
              rows: 24,
              ...(intent.launch && { launch: intent.launch }),
              ...(importHistory &&
                intent.legacyTerminalId && {
                  legacyTerminalId: intent.legacyTerminalId,
                }),
            });
      sessionRef.current = readOnly ? null : session;
      setViewSession(
        session
          ? readOnly
            ? watchOnly(toTerminalViewSession(session))
            : toTerminalViewSession(session)
          : null,
      );
      unsubscribe = session?.subscribe({ change: render });
      if (session) render(session);
      else setWsError('This terminal session is unavailable.');
    };
    const render = (current: TerminalSession) => {
      if (current !== session) return;
      if (current.terminalId && current.terminalId !== reported) {
        reported = current.terminalId;
        intentRef.current.onOpened?.(current.terminalId);
      }
      setConnected(current.state === 'ready');
      if (current.state === 'failed') {
        // Saved history nobody can prove this Project owns stays on disk;
        // the tab still gets a fresh shell rather than a refusal.
        if (
          current.error?.code === 'refused' &&
          !current.terminalId &&
          intent.legacyTerminalId &&
          !intent.terminalId
        ) {
          intent.legacyTerminalId = undefined;
          queueMicrotask(() => begin(false));
          return;
        }
        if (current.error?.code === 'pty-unavailable')
          setUnavailableReason(current.error.message);
        else setWsError(current.error?.message ?? 'Terminal unavailable.');
        return;
      }
      if (current.status === 'exited' || current.status === 'failed') {
        setWsError('The shell has exited.');
        return;
      }
      setWsError(
        current.state === 'reconnecting' ? 'Terminal reconnecting…' : null,
      );
    };
    begin(true);

    return () => {
      unsubscribe?.();
      // Unmounting is presentation lifecycle, not terminal lifecycle: the
      // shell keeps running and the next view resumes its output.
      session?.detach();
      sessionRef.current = null;
      setViewSession(null);
    };
  }, [
    store,
    projectId,
    bindingKey,
    key,
    attachOnly,
    readOnly,
    connectionAttempt,
  ]);

  // Mirror of the composer's unmount guard: blur never fires for an
  // unmounted terminal, and a stuck terminalFocused would suppress every
  // {not:'terminalFocused'} shortcut globally.
  useEffect(() => () => setShortcutContext('terminalFocused', false), []);

  const sendSelectionToChat = async (terminalOutput: string) => {
    // The view hands over its one complete selection, read from the
    // emulator at the hand-off: the credential scan sees all of it even when
    // the PTY delivered it across several reads.
    if (!terminalOutput) return;
    if (selectionContainsCredential(terminalOutput)) {
      setHandoffError(
        'Selection contains a credential and was not added to chat.',
      );
      return;
    }
    if (!activeChat) {
      setHandoffError('Open a chat before sending terminal output to it.');
      return;
    }
    const cwd = await sessionRef.current?.cwd().catch(() => null);
    if (!cwd) {
      setHandoffError(
        'The terminal working directory is unavailable; output was not added to chat.',
      );
      return;
    }

    const existingDraft =
      activeChatsStore.getSnapshot()[activeChat]?.input ?? getDraft(activeChat);
    const handoff = buildTerminalSelectionHandoff({
      selection: terminalOutput,
      cwd,
    });
    const nextDraft = existingDraft
      ? `${existingDraft}\n\n${handoff}`
      : handoff;
    // Persist and project the same draft through the real composer seams.
    // Neither operation dispatches a provider turn; sending remains the
    // composer's explicit user action.
    setDraft(activeChat, nextDraft);
    updateChat(activeChat, { input: getDraft(activeChat) });
    setHandoffError(null);
  };

  // URLs open in the Browser pane and `path:line` in the file preview, the
  // same placement a chat link takes.
  const openLink = async (link: TerminalLinkTarget) => {
    if (!projectId) return;
    if (link.kind === 'url') {
      if (!openBrowserSession) {
        setHandoffError('The Browser pane cannot open here.');
        return;
      }
      const api = browserPaneApi(apiBase, authenticatedFetch);
      try {
        const { browserSessionId } = await api.create({
          projectSlug,
          url: link.url,
        });
        const outcome = openBrowserSession({ projectId, browserSessionId });
        if (outcome.ok) setHandoffError(null);
        else {
          // No pane shows it: close the session rather than leave it running.
          void api.close(browserSessionId).catch(() => undefined);
          setHandoffError(describeOpenInRegionRefusal(outcome.reason));
        }
      } catch (error) {
        setHandoffError(
          error instanceof Error ? error.message : 'The link could not open.',
        );
      }
      return;
    }
    const cwd = await sessionRef.current?.cwd().catch(() => null);
    const path = terminalLinkRelativePath(workingDir, cwd ?? null, link.path);
    if (!path) {
      setHandoffError('That file is outside this Project.');
      return;
    }
    if (!openFilePreview) {
      setHandoffError('Files cannot open here.');
      return;
    }
    const thread = bindingKey?.startsWith('thread:')
      ? bindingKey.slice('thread:'.length)
      : undefined;
    const outcome = openFilePreview({
      projectId,
      projectSlug,
      path,
      lineRange: { start: link.line, end: link.line },
      ...(thread ? { thread } : {}),
    });
    setHandoffError(
      outcome.ok ? null : describeOpenInRegionRefusal(outcome.reason),
    );
  };

  // Register as the active terminal writer only while this tab is visible, so
  // injected input always lands in the terminal the user is looking at.
  const writerKey = key ?? 'terminal';
  useEffect(() => {
    if (!isActive) return;
    activeTerminalWriter.setActive(writerKey, (text) =>
      sessionRef.current ? sessionRef.current.write(text) : false,
    );
    return () => activeTerminalWriter.clearActive(writerKey);
  }, [isActive, writerKey]);

  if (unavailableReason) {
    // Loud degradation (#1244): name the reason, then keep the user working
    // through the non-PTY command executor.
    return (
      <div className="coding-terminal-shell">
        <p role="alert">{unavailableReason}</p>
        <CommandExecutor projectSlug={projectSlug} workingDir={workingDir} />
      </div>
    );
  }

  return (
    <div className="coding-terminal-shell">
      {wsError ? (
        <div className="coding-terminal-connection" role="alert">
          <span>{wsError}</span>
          <button
            type="button"
            onClick={() => setConnectionAttempt((attempt) => attempt + 1)}
          >
            Reconnect terminal
          </button>
        </div>
      ) : !connected ? (
        <p role="status">Connecting to the terminal…</p>
      ) : null}
      {handoffError && <p role="alert">{handoffError}</p>}
      <div
        className="coding-terminal"
        onFocusCapture={() => setShortcutContext('terminalFocused', true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setShortcutContext('terminalFocused', false);
        }}
      >
        <TerminalView
          session={viewSession}
          label="Terminal"
          fontSize={fontSize}
          touchKeys={isMobile}
          notices={false}
          onAddToChat={(text) => void sendSelectionToChat(text)}
          onOpenLink={(link) => void openLink(link)}
        />
      </div>
    </div>
  );
}

/** `view` as an observer sees it: no input and no resize reach the session. */
function watchOnly(view: TerminalViewSession): TerminalViewSession {
  return {
    get state() {
      return view.state;
    },
    readOnly: true,
    subscribe: (listener) => view.subscribe(listener),
    write: () => false,
    resize: () => {},
  };
}

// ─── Alternative command executor ────────────────────────────────────────────

function CommandExecutor({
  projectSlug,
  workingDir,
}: {
  projectSlug: string;
  workingDir: string;
}) {
  const { apiBase } = useApiBase();
  const isMobile = useIsMobile();
  const [input, setInput] = useState('');
  // Mirror of the composer's unmount guard: blur never fires for an
  // unmounted terminal, and a stuck terminalFocused would suppress every
  // {not:'terminalFocused'} shortcut globally.
  useEffect(() => () => setShortcutContext('terminalFocused', false), []);

  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [lines, setLines] = useState<
    { text: string; type: 'cmd' | 'out' | 'err' }[]
  >([]);
  const [running, setRunning] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, []);

  const run = async () => {
    const cmd = input.trim();
    if (!cmd || !workingDir) return;
    setHistory((h) => [cmd, ...h.slice(0, 49)]);
    setHistIdx(-1);
    setLines((l) => [...l, { text: `$ ${cmd}`, type: 'cmd' }]);
    setInput('');
    setRunning(true);
    try {
      // #2412: the command runs in this Project's folder, and a paired
      // device needs the operator's Run commands grant; a refusal arrives
      // as the error below, in the server's words.
      const d = await executeCodingCommand(
        cmd,
        { projectSlug, workingDir },
        apiBase,
      );
      if (d.stdout)
        setLines((l) => [...l, { text: d.stdout ?? '', type: 'out' }]);
      if (d.stderr)
        setLines((l) => [...l, { text: d.stderr ?? '', type: 'err' }]);
    } catch (e: any) {
      setLines((l) => [...l, { text: e.message, type: 'err' }]);
    }
    setRunning(false);
  };

  useEffect(() => {
    if (!isMobile && !running) inputRef.current?.focus();
  }, [isMobile, running]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isComposingKeyEvent(e)) {
      run();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.min(histIdx + 1, history.length - 1);
      setHistIdx(next);
      if (history[next]) setInput(history[next]);
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = histIdx - 1;
      setHistIdx(next);
      setInput(next < 0 ? '' : (history[next] ?? ''));
    }
    if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setLines([]);
    }
  };

  return (
    <div
      className="coding-terminal-command-executor"
      role="application"
      aria-label="Terminal"
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--terminal-background)',
        fontFamily: 'monospace',
        fontSize: '12px',
      }}
      onClick={() => inputRef.current?.focus()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 12px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {lines.map((l, i) => (
          <div
            key={i}
            style={{
              color:
                l.type === 'cmd'
                  ? 'var(--terminal-cyan)'
                  : l.type === 'err'
                    ? 'var(--terminal-red)'
                    : // Output a step quieter than the input line (#b0b0b0 on
                      // the dark terminal, as before).
                      'color-mix(in srgb, var(--terminal-foreground) 75%, var(--terminal-background))',
              lineHeight: '1.5',
            }}
          >
            {l.text}
          </div>
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '4px 12px 8px',
          gap: '6px',
          flexShrink: 0,
        }}
      >
        <span style={{ color: 'var(--terminal-cyan)' }}>$</span>
        <input
          ref={inputRef}
          className="coding-terminal-command-executor__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder={
            workingDir
              ? running
                ? 'Running...'
                : 'Type a command...'
              : 'No working directory'
          }
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: 'var(--terminal-foreground)',
            fontFamily: 'inherit',
            fontSize: 'inherit',
          }}
        />
      </div>
    </div>
  );
}
