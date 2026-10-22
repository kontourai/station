import {
  assertClientRawEgressAllowed,
  executeCodingCommand,
  fetchTerminalPort,
} from '@kontourai/station-sdk';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import {
  BrowserWebSocketAuthGate,
  isRemoteEndpoint,
  websocketCloseError,
} from '../../utils/browserWebSocketAuth';
import { activeTerminalWriter } from './activeTerminal';
import {
  buildTerminalSelectionHandoff,
  selectionContainsCredential,
} from './terminalSelectionHandoff';
import { readTerminalTheme } from './terminalTheme';

/** Server events that belong to one terminal session (`TerminalEvent`). */
const SESSION_EVENT_TYPES = new Set(['data', 'started', 'exited', 'activity']);

export function TerminalPanel({
  projectSlug,
  workingDir,
  terminalId = 'default',
  shell,
  shellArgs,
  isActive = false,
}: {
  projectSlug: string;
  workingDir: string;
  terminalId?: string;
  shell?: string;
  shellArgs?: string[];
  /** True when this is the visible terminal tab; only then does it accept
   * externally-injected input (e.g. "Send to terminal" from the file tree). */
  isActive?: boolean;
}) {
  const {
    apiBase,
    connectionId,
    credentialProvider: liveCredentials,
  } = useApiBase();
  const credential = liveCredentials.getCredential();
  const protocolVersion = liveCredentials.getProtocolVersion();
  const credentialProvider = useMemo(
    () => ({
      getCredential: () => credential,
      getProtocolVersion: () => protocolVersion,
    }),
    [credential, protocolVersion],
  );
  const activeChat = useNavigation((state) => state.activeChat);
  const { getDraft, setDraft, updateChat } = useActiveChatActions();
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
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
  // Populated by the WS effect; sends text to the PTY as if typed.
  const sendTextRef = useRef<((text: string) => boolean) | null>(null);
  const getLiveCwdRef = useRef<(() => Promise<string | null>) | null>(null);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit reconnect restarts this socket with the same terminal identity.
  useEffect(() => {
    if (!containerRef.current) return;
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

    let ws: WebSocket | null = null;
    let sessionId: string | null = null;
    let disposed = false;
    let exited = false;
    let cwdRequest = 0;
    let resizeFrame: number | null = null;
    let lastSize = { cols: terminal.cols, rows: terminal.rows };
    const cwdRequests = new Map<string, (cwd: string | null) => void>();

    const ensureTerminalSocketAllowed = (): boolean => {
      try {
        assertClientRawEgressAllowed(apiBase, 'terminal', connectionId);
        return true;
      } catch (error) {
        ws?.close();
        if (!disposed)
          setUnavailableReason(
            error instanceof Error
              ? error.message
              : 'Terminal connections are unavailable for the selected Station.',
          );
        return false;
      }
    };

    const connectWs = async () => {
      if (!ensureTerminalSocketAllowed()) return;
      let port: number;
      try {
        port = await fetchTerminalPort(apiBase);
      } catch {
        if (!disposed) setWsError('Terminal unavailable.');
        return;
      }
      if (disposed) return;
      // Port discovery may await a routed application request. Recheck the
      // selected binding directly before opening the raw WebSocket.
      if (!ensureTerminalSocketAllowed()) return;

      // Connect to the host the app was loaded from (e.g. the LAN IP on a
      // phone), not `localhost` — on a remote device localhost is the device
      // itself and never reaches the terminal server. The WS server binds
      // 0.0.0.0, so the LAN host resolves correctly.
      const base = new URL(apiBase, window.location.href);
      const wsProto = base.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${wsProto}//${base.hostname}:${port}`);

      const sendOpen = () => {
        if (
          !ensureTerminalSocketAllowed() ||
          !ws ||
          ws.readyState !== WebSocket.OPEN
        )
          return;
        lastSize = { cols: terminal.cols, rows: terminal.rows };
        ws.send(
          JSON.stringify({
            type: 'open',
            projectSlug,
            terminalId,
            cwd: workingDir,
            ...(shell && { shell }),
            ...(shellArgs && { shellArgs }),
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
      };
      const authGate = new BrowserWebSocketAuthGate(
        isRemoteEndpoint(apiBase, window.location.href),
        credentialProvider,
        sendOpen,
        (message) => {
          if (!disposed) setWsError(message);
          ws?.close();
        },
      );

      ws.onopen = () => {
        if (!ensureTerminalSocketAllowed()) return;
        authGate.open(ws!);
      };

      ws.onmessage = (event) => {
        if (disposed) return;
        if (!ensureTerminalSocketAllowed()) return;
        if (authGate.consume(event.data as string)) return;
        try {
          const msg = JSON.parse(event.data as string);
          // Defense in depth: session events for any other session (or before
          // this panel's snapshot names its own) never reach this terminal.
          if (
            SESSION_EVENT_TYPES.has(msg.type) &&
            (!sessionId || msg.sessionId !== sessionId)
          )
            return;
          if (msg.type === 'snapshot') {
            sessionId = msg.sessionId;
            scheduleResize();
            setConnected(true);
            if (msg.history) terminal.write(msg.history);
          } else if (msg.type === 'data') {
            terminal.write(msg.data);
          } else if (msg.type === 'cwd') {
            const resolve = cwdRequests.get(msg.requestId);
            if (resolve) {
              cwdRequests.delete(msg.requestId);
              resolve(typeof msg.cwd === 'string' ? msg.cwd : null);
            }
          } else if (msg.type === 'exited') {
            exited = true;
            setConnected(false);
            setWsError('The shell has exited.');
            terminal.write('\r\n[terminal exited]\r\n');
          } else if (
            msg.type === 'error' &&
            msg.code === 'terminal-unavailable' &&
            typeof msg.message === 'string'
          ) {
            // The server's PTY backend (node-pty) is unavailable (#1244).
            // Surface the server's actionable reason and swap to the
            // command-executor fallback, which runs without a PTY.
            setUnavailableReason(msg.message);
          }
        } catch {
          /* ignore malformed */
        }
      };

      ws.onerror = () => {
        if (!disposed) {
          setConnected(false);
          setWsError('Terminal disconnected.');
        }
      };
      ws.onclose = (event) => {
        if (!disposed && !exited) {
          console.warn(`[Terminal] ${websocketCloseError(event.code)}`);
          setConnected(false);
          setWsError(websocketCloseError(event.code));
        }
      };
    };

    connectWs();

    const dataDispose = terminal.onData((data) => {
      if (
        ensureTerminalSocketAllowed() &&
        ws?.readyState === WebSocket.OPEN &&
        sessionId
      ) {
        ws.send(JSON.stringify({ type: 'data', sessionId, data }));
      }
    });

    // Expose a way to inject text into this PTY (read ws/sessionId at call time).
    // Refuse once the PTY has exited so callers don't write into a dead shell.
    sendTextRef.current = (text: string) => {
      if (
        ensureTerminalSocketAllowed() &&
        !exited &&
        ws?.readyState === WebSocket.OPEN &&
        sessionId
      ) {
        ws.send(JSON.stringify({ type: 'data', sessionId, data: text }));
        return true;
      }
      return false;
    };

    getLiveCwdRef.current = () => {
      if (
        !ensureTerminalSocketAllowed() ||
        !ws ||
        ws.readyState !== WebSocket.OPEN ||
        !sessionId ||
        exited
      ) {
        return Promise.resolve(null);
      }
      const requestId = `${terminalId}:cwd:${cwdRequest++}`;
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          cwdRequests.delete(requestId);
          resolve(null);
        }, 1_000);
        cwdRequests.set(requestId, (cwd) => {
          clearTimeout(timeout);
          resolve(cwd);
        });
        ws!.send(JSON.stringify({ type: 'cwd', sessionId, requestId }));
      });
    };

    const selectionDispose = terminal.onSelectionChange(() => {
      setSelection(terminal.hasSelection() ? terminal.getSelection() : '');
      setHandoffError(null);
    });

    const scheduleResize = () => {
      if (disposed || resizeFrame !== null) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        if (disposed) return;
        const proposed = fitAddon.proposeDimensions();
        if (!proposed) return;
        if (proposed.cols !== terminal.cols || proposed.rows !== terminal.rows)
          fitAddon.fit();
        if (terminal.cols === lastSize.cols && terminal.rows === lastSize.rows)
          return;
        if (
          ensureTerminalSocketAllowed() &&
          ws?.readyState === WebSocket.OPEN &&
          sessionId
        ) {
          ws.send(
            JSON.stringify({
              type: 'resize',
              sessionId,
              cols: terminal.cols,
              rows: terminal.rows,
            }),
          );
          lastSize = { cols: terminal.cols, rows: terminal.rows };
        }
      });
    };
    const observer = new ResizeObserver(scheduleResize);
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      disposed = true;
      dataDispose.dispose();
      selectionDispose.dispose();
      for (const resolve of cwdRequests.values()) resolve(null);
      cwdRequests.clear();
      observer.disconnect();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      // Unmounting is presentation lifecycle, not terminal lifecycle. The
      // server retains an unowned session briefly so the same identity can
      // reconnect after a host tab switch, move, or layout navigation.
      terminal.dispose();
      terminalRef.current = null;
      ws?.close();
      sendTextRef.current = null;
      getLiveCwdRef.current = null;
    };
  }, [
    apiBase,
    connectionId,
    credentialProvider,
    projectSlug,
    workingDir,
    terminalId,
    shell,
    shellArgs,
    connectionAttempt,
  ]);

  useEffect(() => {
    if (!wsError) return;
    const reconnect = () => setConnectionAttempt((attempt) => attempt + 1);
    window.addEventListener('online', reconnect);
    return () => window.removeEventListener('online', reconnect);
  }, [wsError]);

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
    const cwd = await getLiveCwdRef.current?.();
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
  useEffect(() => {
    if (!isActive) return;
    activeTerminalWriter.setActive(terminalId, (text) =>
      sendTextRef.current ? sendTextRef.current(text) : false,
    );
    return () => activeTerminalWriter.clearActive(terminalId);
  }, [isActive, terminalId]);

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
                sendTextRef.current?.(input);
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
