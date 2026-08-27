import {
  executeCodingCommand,
  fetchTerminalPort,
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
import { useIsMobile } from '../../hooks/useIsMobile';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
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
  const { apiBase, credentialProvider } = useApiBase();
  const { activeChat } = useNavigation();
  const { getDraft, setDraft, updateChat } = useActiveChatActions();
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [wsError, setWsError] = useState(false);
  const [selection, setSelection] = useState('');
  const [handoffError, setHandoffError] = useState<string | null>(null);
  // Populated by the WS effect; sends text to the PTY as if typed.
  const sendTextRef = useRef<((text: string) => boolean) | null>(null);
  const getLiveCwdRef = useRef<(() => Promise<string | null>) | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Bump the glyph size on phone-width viewports — xterm renders to a canvas,
    // so the readable-text fix has to live in JS, not CSS. Mirrors the 768px
    // mobile breakpoint used across the stylesheets.
    const isMobileViewport =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 768px)').matches;

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontSize: isMobileViewport ? 14 : 12,
      fontFamily:
        "'MesloLGS NF', 'MesloLGM Nerd Font', 'Hack Nerd Font', 'FiraCode Nerd Font', 'JetBrainsMono Nerd Font', Menlo, courier-new, courier, monospace",
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#7ec8e3',
        selectionBackground: '#3a3a5e',
        black: '#1a1a2e',
        brightBlack: '#4a4a6e',
        red: '#f44336',
        brightRed: '#ef5350',
        green: '#4caf50',
        brightGreen: '#66bb6a',
        yellow: '#ffeb3b',
        brightYellow: '#fff176',
        blue: '#2196f3',
        brightBlue: '#42a5f5',
        magenta: '#9c27b0',
        brightMagenta: '#ab47bc',
        cyan: '#7ec8e3',
        brightCyan: '#80deea',
        white: '#e0e0e0',
        brightWhite: '#ffffff',
      },
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
    const cwdRequests = new Map<string, (cwd: string | null) => void>();

    const connectWs = async () => {
      let port: number;
      try {
        port = await fetchTerminalPort(apiBase);
      } catch {
        if (!disposed) setWsError(true);
        return;
      }

      // Connect to the host the app was loaded from (e.g. the LAN IP on a
      // phone), not `localhost` — on a remote device localhost is the device
      // itself and never reaches the terminal server. The WS server binds
      // 0.0.0.0, so the LAN host resolves correctly.
      const base = new URL(apiBase, window.location.href);
      const wsProto = base.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${wsProto}//${base.hostname}:${port}`);

      const sendOpen = () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
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
        () => {
          if (!disposed) setWsError(true);
          ws?.close();
        },
      );

      ws.onopen = () => {
        authGate.open(ws!);
      };

      ws.onmessage = (event) => {
        if (authGate.consume(event.data as string)) return;
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'snapshot') {
            sessionId = msg.sessionId;
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
            terminal.write('\r\n[terminal exited]\r\n');
          }
        } catch {
          /* ignore malformed */
        }
      };

      ws.onerror = () => {
        if (!disposed) setWsError(true);
      };
      ws.onclose = (event) => {
        if (!disposed && event.code !== 1000) {
          console.warn(`[Terminal] ${websocketCloseError(event.code)}`);
          setWsError(true);
        }
      };
    };

    connectWs();

    const dataDispose = terminal.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN && sessionId) {
        ws.send(JSON.stringify({ type: 'data', sessionId, data }));
      }
    });

    // Expose a way to inject text into this PTY (read ws/sessionId at call time).
    // Refuse once the PTY has exited so callers don't write into a dead shell.
    sendTextRef.current = (text: string) => {
      if (!exited && ws?.readyState === WebSocket.OPEN && sessionId) {
        ws.send(JSON.stringify({ type: 'data', sessionId, data: text }));
        return true;
      }
      return false;
    };

    getLiveCwdRef.current = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN || !sessionId || exited) {
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

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      if (ws?.readyState === WebSocket.OPEN && sessionId) {
        ws.send(
          JSON.stringify({
            type: 'resize',
            sessionId,
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
      }
    });
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      disposed = true;
      dataDispose.dispose();
      selectionDispose.dispose();
      for (const resolve of cwdRequests.values()) resolve(null);
      cwdRequests.clear();
      observer.disconnect();
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
    credentialProvider,
    projectSlug,
    workingDir,
    terminalId,
    shell,
    shellArgs,
  ]);

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
    try {
      await navigator.clipboard.writeText(terminalOutput);
      setHandoffError(null);
    } catch {
      setHandoffError('Unable to copy the terminal selection.');
    }
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

  if (wsError) {
    return <CommandExecutor workingDir={workingDir} />;
  }

  return (
    <div className="coding-terminal-shell">
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
    </div>
  );
}

// ─── Alternative command executor ────────────────────────────────────────────

function CommandExecutor({ workingDir }: { workingDir: string }) {
  const { apiBase } = useApiBase();
  const isMobile = useIsMobile();
  const [input, setInput] = useState('');
  // Mirror of the composer's unmount guard: blur never fires for an
  // unmounted terminal, and a stuck terminalFocused would suppress every
  // {not:'terminalFocused'} shortcut globally (sol review finding).
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
      const d = await executeCodingCommand(cmd, workingDir, apiBase);
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
        background: '#1a1a2e',
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
                  ? '#7ec8e3'
                  : l.type === 'err'
                    ? '#f44336'
                    : '#b0b0b0',
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
        <span style={{ color: '#7ec8e3' }}>$</span>
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
            color: '#e0e0e0',
            fontFamily: 'inherit',
            fontSize: 'inherit',
          }}
        />
      </div>
    </div>
  );
}
