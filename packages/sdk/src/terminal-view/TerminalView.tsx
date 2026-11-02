import { Skeleton } from '@kontourai/ui/react';
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { ActionControl } from '../components/ActionControl';
import { ErrorState } from '../components/ErrorState';
import { TerminalController } from './controller';
import { loadSymbolsFont, TERMINAL_FONT_FAMILY } from './font';
import type { TerminalLinkTarget } from './links';
import type { FontSpec } from './render/glyph-atlas';
import type { TerminalViewSession } from './session';
import './TerminalView.css';

export interface TerminalViewProps {
  /** The session to show; `null` renders the terminal without a program. */
  session: TerminalViewSession | null;
  /** Accessible name, e.g. "Terminal: main". */
  label?: string;
  fontSize?: number;
  fontFamily?: string;
  /**
   * Screen reader mode keeps a navigable text mirror and announces output.
   * Hosts pass the user's setting; when unset it follows `detectScreenReader`.
   */
  screenReaderMode?: boolean;
  /** Host signal that an assistive technology is active, if it has one. */
  detectScreenReader?: () => boolean;
  /** Show the on-screen key row (Esc, Tab, sticky Ctrl, arrows). */
  touchKeys?: boolean;
  /** Where URL and file links go. Without it links are inert text. */
  onOpenLink?(target: TerminalLinkTarget): void;
  /** Adds the selection to the active chat; the menu hides it when absent. */
  onAddToChat?(text: string): void;
  onTitleChange?(title: string): void;
  onBell?(): void;
  /** Retries a failed or exited session. */
  onReconnect?(): void;
  /**
   * Show connection and exit notices over the terminal (default). A host that
   * reports those itself, with its own recovery action, turns them off.
   */
  notices?: boolean;
  className?: string;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function moveFocus(from: HTMLElement, direction: 'next' | 'previous'): void {
  const all = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !from.contains(el) && el.offsetParent !== null,
  );
  const position = (el: HTMLElement) =>
    from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING;
  const target =
    direction === 'next'
      ? all.find((el) => position(el))
      : [...all].reverse().find((el) => !position(el));
  (target ?? from).focus();
}

function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  return useSyncExternalStore(
    (notify) => {
      const media = window.matchMedia?.(query);
      media?.addEventListener?.('change', notify);
      return () => media?.removeEventListener?.('change', notify);
    },
    () => window.matchMedia?.(query).matches ?? false,
    () => false,
  );
}

const SESSION_NOTICE: Record<string, string> = {
  connecting: 'Connecting…',
  replaying: 'Restoring output…',
  disconnected: 'Disconnected. Reconnecting…',
  exited: 'The program has exited.',
  failed: 'The terminal connection failed.',
};

/**
 * Station's terminal surface over Ghostty's libghostty-vt. The emulator runs
 * in a worker; this component owns the canvas, input and chrome.
 */
export function TerminalView({
  session,
  label = 'Terminal',
  fontSize,
  fontFamily = TERMINAL_FONT_FAMILY,
  screenReaderMode,
  detectScreenReader,
  touchKeys = false,
  onOpenLink,
  onAddToChat,
  onTitleChange,
  onBell,
  onReconnect,
  notices = true,
  className,
}: TerminalViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [controller, setController] = useState<TerminalController | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [needle, setNeedle] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [notice, setNotice] = useState('');
  const reducedMotion = useReducedMotion();
  const helpId = useId();
  const mirrorId = useId();
  const screenReader = screenReaderMode ?? detectScreenReader?.() ?? false;
  const size =
    fontSize ??
    (typeof window !== 'undefined' &&
    window.matchMedia?.('(max-width: 767px)').matches
      ? 14
      : 13);
  const font = useMemo<FontSpec>(
    () => ({ family: fontFamily, size, lineHeight: 1.2 }),
    [fontFamily, size],
  );

  const callbacks = useRef({ onOpenLink, onTitleChange, onBell });
  callbacks.current = { onOpenLink, onTitleChange, onBell };

  // biome-ignore lint/correctness/useExhaustiveDependencies: a retry rebuilds the engine; font and modes update in place below.
  useEffect(() => {
    const grid = gridRef.current;
    const canvas = canvasRef.current;
    const input = inputRef.current;
    if (!grid || !canvas || !input) return;
    const next = new TerminalController(
      { root: grid, canvas, input },
      {
        font,
        screenReader,
        reducedMotion,
        onLink: (target) => callbacks.current.onOpenLink?.(target),
        onTitle: (title) => callbacks.current.onTitleChange?.(title),
        onBell: () => callbacks.current.onBell?.(),
        onFocusLeave: (direction) =>
          rootRef.current && moveFocus(rootRef.current, direction),
        onContextMenu: (position) => setMenu(position),
        onFindRequest: () => setFindOpen(true),
      },
    );
    setController(next);
    void loadSymbolsFont().then(() => next.setFont({ ...font }));
    void next.start();
    return () => {
      next.dispose();
      setController(null);
    };
  }, [attempt]);

  useEffect(() => controller?.setSession(session), [controller, session]);
  useEffect(
    () => controller?.setScreenReader(screenReader),
    [controller, screenReader],
  );
  useEffect(
    () => controller?.setReducedMotion(reducedMotion),
    [controller, reducedMotion],
  );
  useEffect(() => controller?.setFont(font), [controller, font]);

  const noop = useCallback(() => () => {}, []);
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noop,
    () => controller?.getSnapshot() ?? null,
    () => null,
  );

  useEffect(() => {
    if (findOpen) findRef.current?.focus();
  }, [findOpen]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);

  const readOnly = session?.readOnly ?? true;
  const status = snapshot?.status ?? 'loading';
  const sessionState = snapshot?.session ?? 'none';

  const closeMenu = () => {
    setMenu(null);
    controller?.focus();
  };
  const runFind = async (
    direction: 'next' | 'prev' | 'same',
    value = needle,
  ) => {
    await controller?.find(value, direction);
  };
  const closeFind = () => {
    setFindOpen(false);
    setNeedle('');
    void controller?.find('', 'same');
    controller?.focus();
  };

  const menuItems: {
    label: string;
    run: () => void | Promise<void>;
    disabled?: boolean;
  }[] = [
    {
      label: 'Copy',
      disabled: !snapshot?.hasSelection,
      run: async () =>
        setNotice((await controller?.copy()) ? 'Copied.' : 'Copy failed.'),
    },
    {
      label: 'Paste',
      disabled: readOnly,
      run: async () => {
        if (!(await controller?.pasteFromClipboard()))
          setNotice(
            'Clipboard access was refused. Use the keyboard paste shortcut.',
          );
      },
    },
    { label: 'Select all', run: () => controller?.selectAll() },
    ...(onAddToChat
      ? [
          {
            label: 'Add to chat',
            disabled: !snapshot?.hasSelection,
            run: async () => {
              const text = await controller?.selectionText();
              if (text) onAddToChat(text);
            },
          },
        ]
      : []),
    { label: 'Find', run: () => setFindOpen(true) },
    {
      label: 'Jump to latest',
      disabled: snapshot?.atBottom ?? true,
      run: () => controller?.scrollToBottom(),
    },
    { label: 'Clear', run: () => controller?.clear() },
  ];

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([disabled])',
      ) ?? []),
    ];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === 'Tab') event.preventDefault();
  };

  const scrollbar = snapshot?.scrollbar;
  const scrollable = scrollbar && scrollbar.total > scrollbar.length;

  return (
    <div
      ref={rootRef}
      className={['station-terminal', className].filter(Boolean).join(' ')}
      data-renderer={snapshot?.renderer ?? undefined}
      data-state={status}
    >
      <p id={helpId} className="station-terminal__visually-hidden">
        Press Escape then Tab to leave the terminal. Shift+F10 opens the
        terminal menu.
      </p>
      {findOpen && (
        <search
          className="station-terminal__find"
          aria-label="Find in terminal"
        >
          <input
            ref={findRef}
            type="search"
            aria-label="Find"
            placeholder="Find"
            value={needle}
            onChange={(event) => {
              setNeedle(event.target.value);
              void runFind('same', event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void runFind(event.shiftKey ? 'prev' : 'next');
              } else if (event.key === 'Escape') {
                event.preventDefault();
                closeFind();
              }
            }}
          />
          <span className="station-terminal__find-count" aria-live="polite">
            {needle
              ? snapshot?.search?.total
                ? `${(snapshot.search.selected ?? 0) + 1} of ${snapshot.search.total}`
                : 'No results'
              : ''}
          </span>
          <ActionControl
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Previous match"
            onClick={() => void runFind('prev')}
          >
            ↑
          </ActionControl>
          <ActionControl
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Next match"
            onClick={() => void runFind('next')}
          >
            ↓
          </ActionControl>
          <ActionControl
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Close find"
            onClick={closeFind}
          >
            ✕
          </ActionControl>
        </search>
      )}
      <div className="station-terminal__body">
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would give the canvas surface form semantics. */}
        <div
          ref={gridRef}
          className="station-terminal__grid"
          role="group"
          aria-roledescription="terminal"
          aria-label={snapshot?.title ? `${label}: ${snapshot.title}` : label}
        >
          <canvas ref={canvasRef} className="station-terminal__canvas" />
          <textarea
            ref={inputRef}
            className="station-terminal__input"
            aria-label={`${label} input`}
            aria-describedby={helpId}
            aria-readonly={readOnly}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="send"
            rows={1}
            style={
              snapshot?.cursorCss
                ? {
                    left: snapshot.cursorCss.left,
                    top: snapshot.cursorCss.top,
                    height: snapshot.cursorCss.height,
                  }
                : undefined
            }
          />
          {snapshot?.composing ? (
            <span
              className="station-terminal__composition"
              style={{
                left: snapshot.cursorCss?.left ?? 0,
                top: snapshot.cursorCss?.top ?? 0,
              }}
            >
              {snapshot.composing}
            </span>
          ) : null}
        </div>
        {scrollable && scrollbar ? (
          <div
            className="station-terminal__scrollbar"
            role="scrollbar"
            aria-label="Terminal scrollback"
            aria-orientation="vertical"
            aria-valuemin={0}
            aria-valuemax={scrollbar.total - scrollbar.length}
            aria-valuenow={scrollbar.offset}
            aria-controls={mirrorId}
            tabIndex={-1}
            onPointerDown={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const jump = (clientY: number) =>
                controller?.scrollTo(
                  Math.round(
                    ((clientY - rect.top) / rect.height) * scrollbar.total -
                      scrollbar.length / 2,
                  ),
                );
              jump(event.clientY);
              event.currentTarget.setPointerCapture(event.pointerId);
              const move = (e: PointerEvent) => jump(e.clientY);
              const target = event.currentTarget;
              target.addEventListener('pointermove', move);
              target.addEventListener(
                'pointerup',
                () => target.removeEventListener('pointermove', move),
                { once: true },
              );
            }}
          >
            <div
              className="station-terminal__thumb"
              style={{
                top: `${(scrollbar.offset / scrollbar.total) * 100}%`,
                height: `${Math.max(4, (scrollbar.length / scrollbar.total) * 100)}%`,
              }}
            />
          </div>
        ) : null}
        {snapshot && !snapshot.atBottom ? (
          <ActionControl
            type="button"
            size="sm"
            className="station-terminal__latest"
            onClick={() => {
              controller?.scrollToBottom();
              controller?.focus();
            }}
          >
            Jump to latest
          </ActionControl>
        ) : null}
        {status === 'loading' ? (
          <div
            className="station-terminal__overlay"
            role="status"
            aria-label="Starting terminal"
          >
            <Skeleton />
          </div>
        ) : status === 'error' ? (
          <div className="station-terminal__overlay">
            <ErrorState
              title="The terminal could not start"
              description={snapshot?.failure ?? undefined}
              action={
                <ActionControl
                  type="button"
                  onClick={() => setAttempt((n) => n + 1)}
                >
                  Retry
                </ActionControl>
              }
              variant="compact"
            />
          </div>
        ) : notices &&
          sessionState !== 'ready' &&
          sessionState !== 'none' &&
          SESSION_NOTICE[sessionState] ? (
          <div className="station-terminal__banner" role="status">
            <span>{SESSION_NOTICE[sessionState]}</span>
            {(sessionState === 'exited' || sessionState === 'failed') &&
            onReconnect ? (
              <ActionControl type="button" size="sm" onClick={onReconnect}>
                {sessionState === 'exited' ? 'Restart' : 'Reconnect'}
              </ActionControl>
            ) : null}
          </div>
        ) : null}
      </div>
      {touchKeys ? (
        <div
          className="station-terminal__keys"
          role="toolbar"
          aria-label="Terminal keys"
        >
          {(
            [
              [
                'Interrupt (Ctrl+C)',
                'Ctrl+C',
                () => controller?.sendKey('KeyC', 'c', 1 << 1),
              ],
              ['Escape', 'Esc', () => controller?.sendKey('Escape', 'Escape')],
              ['Tab', 'Tab', () => controller?.sendKey('Tab', 'Tab')],
              [
                'Previous command',
                '↑',
                () => controller?.sendKey('ArrowUp', 'ArrowUp'),
              ],
              [
                'Next command',
                '↓',
                () => controller?.sendKey('ArrowDown', 'ArrowDown'),
              ],
              [
                'Left',
                '←',
                () => controller?.sendKey('ArrowLeft', 'ArrowLeft'),
              ],
              [
                'Right',
                '→',
                () => controller?.sendKey('ArrowRight', 'ArrowRight'),
              ],
            ] as const
          ).map(([name, text, run]) => (
            <button
              key={name}
              type="button"
              aria-label={name}
              disabled={readOnly}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                run();
                controller?.focus();
              }}
            >
              {text}
            </button>
          ))}
          <button
            type="button"
            aria-label="Control (applies to the next key)"
            aria-pressed={snapshot?.stickyCtrl ?? false}
            disabled={readOnly}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              controller?.setStickyCtrl(!snapshot?.stickyCtrl);
              controller?.focus();
            }}
          >
            Ctrl
          </button>
        </div>
      ) : null}
      {menu ? (
        <div
          ref={menuRef}
          className="station-terminal__menu"
          role="menu"
          aria-label="Terminal actions"
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={onMenuKey}
        >
          {menuItems.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={async () => {
                closeMenu();
                await item.run();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
      {screenReader ? (
        <div
          id={mirrorId}
          className="station-terminal__mirror"
          role="document"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: screen reader users read the output mirror line by line from focus.
          tabIndex={0}
          aria-label={`${label} output`}
        >
          {(snapshot?.mirror ?? []).map((line, index) => (
            <div key={index}>{line || ' '}</div>
          ))}
        </div>
      ) : null}
      <div
        className="station-terminal__visually-hidden"
        role="status"
        aria-live="polite"
      >
        {screenReader ? snapshot?.announcement : ''}
        {notice}
      </div>
    </div>
  );
}
