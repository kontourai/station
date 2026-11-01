import type { TerminalLaunchProfile } from '@kontourai/station-contracts/terminal-transport';
import {
  executeCodingCommand,
  type TerminalSession,
  type TerminalSessionTarget,
} from '@kontourai/station-sdk';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import {
  activeChatsStore,
  useActiveChatActions,
} from '../../contexts/ActiveChatsContext';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { setShortcutContext } from '../../contexts/KeyboardShortcutsContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { MOBILE_MEDIA_QUERY, useIsMobile } from '../../hooks/useIsMobile';
import { copyToClipboard } from '../../lib/clipboard';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import { observeRootTheme } from '../../lib/root-theme';
import { activeTerminalWriter } from './activeTerminal';
import {
  buildTerminalSelectionHandoff,
  selectionContainsCredential,
} from './terminalSelectionHandoff';
import { useTerminalSessionStore } from './terminalSessionStore';
import { readTerminalTheme } from './terminalTheme';

/**
 * One terminal view on the shared SDK session store: the same-origin socket
 * every operator device reaches (#3994). The server decides the program and
 * working directory; this view names a session, or asks for a new one.
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
  /** True when this is the visible terminal tab; only then does it accept
   * externally-injected input (e.g. "Send to terminal" from the file tree). */
  isActive?: boolean;
}) {
  const store = useTerminalSessionStore();
  const activeChat = useNavigation((state) => state.activeChat);
  const { getDraft, setDraft, updateChat } = useActiveChatActions();
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const sessionRef = useRef<TerminalSession | null>(null);
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
  const [selection, setSelection] = useState('');
  const [handoffError, setHandoffError] = useState<string | null>(null);
  // The newest open options; a view does not restart when they change.
  const intentRef = useRef({ terminalId, launch, legacyTerminalId, onOpened });
  intentRef.current = { terminalId, launch, legacyTerminalId, onOpened };
  const projectId = target?.projectId;
  const bindingKey = target?.bindingKey;
  const key = viewKey ?? terminalId;

  // The canvas cannot follow the cascade: re-read the terminal variables
  // after any light/dark, palette, accent or branding change on the root.
  useEffect(
    () =>
      observeRootTheme(() => {
        const terminal = terminalRef.current;
        const container = containerRef.current;
        if (terminal && container)
          terminal.options.theme = readTerminalTheme(container);
      }),
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit reconnect restarts this view with the same terminal identity.
  useEffect(() => {
    if (!containerRef.current || !projectId || !bindingKey) return;
    setUnavailableReason(null);
    setWsError(null);
    setConnected(false);

    // Bump the glyph size on a phone — xterm renders to a canvas, so the
    // readable-text fix has to live in JS, not CSS. Read once at mount; a
    // landscape phone counts, as it does for every other mobile affordance.
    const isMobileViewport =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(MOBILE_MEDIA_QUERY).matches;

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontSize: isMobileViewport ? 14 : 12,
      fontFamily:
        "'MesloLGS NF', 'MesloLGM Nerd Font', 'Hack Nerd Font', 'FiraCode Nerd Font', 'JetBrainsMono Nerd Font', Menlo, courier-new, courier, monospace",
      theme: readTerminalTheme(containerRef.current),
    });
    terminalRef.current = terminal;
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();

    const scope = { projectId, bindingKey };
    const intent = intentRef.current;
    if (store.failure) store.restart();
    let session: TerminalSession | null = null;
    let unsubscribe: (() => void) | undefined;
    let reported = intent.terminalId;
    let exited = false;
    const begin = (importHistory: boolean) => {
      unsubscribe?.();
      session = intent.terminalId
        ? store.attach(scope, intent.terminalId)
        : attachOnly
          ? null
          : store.open(scope, {
              cols: terminal.cols,
              rows: terminal.rows,
              ...(intent.launch && { launch: intent.launch }),
              ...(importHistory &&
                intent.legacyTerminalId && {
                  legacyTerminalId: intent.legacyTerminalId,
                }),
            });
      sessionRef.current = session;
      unsubscribe = session?.subscribe({
        output: (data) => terminal.write(data),
        reset: () => terminal.reset(),
        change: render,
      });
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
        if (!exited) terminal.write('\r\n[terminal exited]\r\n');
        exited = true;
        setWsError('The shell has exited.');
        return;
      }
      setWsError(
        current.state === 'reconnecting' ? 'Terminal reconnecting…' : null,
      );
    };
    begin(true);

    const dataDispose = terminal.onData((data) => {
      session?.write(data);
    });
    const selectionDispose = terminal.onSelectionChange(() => {
      setSelection(terminal.hasSelection() ? terminal.getSelection() : '');
      setHandoffError(null);
    });
    let resizeFrame: number | null = null;
    const scheduleResize = () => {
      if (resizeFrame !== null) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        const proposed = fitAddon.proposeDimensions();
        if (!proposed) return;
        if (proposed.cols !== terminal.cols || proposed.rows !== terminal.rows)
          fitAddon.fit();
        // Latest size wins in the store; it is sent once the session is ready.
        session?.resize(terminal.cols, terminal.rows);
      });
    };
    const observer = new ResizeObserver(scheduleResize);
    observer.observe(containerRef.current);

    return () => {
      unsubscribe?.();
      dataDispose.dispose();
      selectionDispose.dispose();
      observer.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      // Unmounting is presentation lifecycle, not terminal lifecycle: the
      // shell keeps running and the next view resumes its output.
      session?.detach();
      sessionRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [store, projectId, bindingKey, key, attachOnly, connectionAttempt]);

  const sendText = (text: string): boolean =>
    sessionRef.current?.write(text) ?? false;

  const sendSelectionToChat = async () => {
    // Read from xterm at the hand-off, rather than from selection state: this
    // is the one complete, contiguous selection on which the credential scan
    // must operate, even if PTY output arrived in multiple reads.
    const terminalOutput = terminalRef.current?.getSelection() ?? '';
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

  const copySelection = async () => {
    const terminalOutput = terminalRef.current?.getSelection() ?? '';
    if (!terminalOutput) return;
    setHandoffError(
      (await copyToClipboard(terminalOutput))
        ? null
        : 'Unable to copy the terminal selection.',
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
      {selection && (
        <fieldset className="coding-terminal-selection-actions">
          <legend>Terminal selection actions</legend>
          <button type="button" onClick={() => void sendSelectionToChat()}>
            Send to chat
          </button>
          <button type="button" onClick={() => void copySelection()}>
            Copy
          </button>
        </fieldset>
      )}
      {handoffError && <p role="alert">{handoffError}</p>}
      <div
        ref={containerRef}
        className="coding-terminal"
        role="application"
        aria-label="Terminal"
        onFocusCapture={() => setShortcutContext('terminalFocused', true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setShortcutContext('terminalFocused', false);
        }}
        onPointerDown={() => terminalRef.current?.focus()}
      />
      {isMobile && (
        <div
          className="coding-terminal-keys"
          role="toolbar"
          aria-label="Terminal keys"
        >
          {[
            ['Interrupt (Ctrl+C)', 'Ctrl+C', '\u0003'],
            ['Tab', 'Tab', '\t'],
            ['Previous command', '↑', '\u001b[A'],
            ['Next command', '↓', '\u001b[B'],
          ].map(([label, text, input]) => (
            <button
              key={label}
              type="button"
              aria-label={label}
              disabled={!connected}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                sendText(input!);
                terminalRef.current?.focus();
              }}
            >
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
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
