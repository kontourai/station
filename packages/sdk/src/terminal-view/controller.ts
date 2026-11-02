/**
 * Everything a terminal view does outside React: the engine worker, the
 * renderer and its frame loop, keyboard/IME/pointer/touch input, visibility,
 * and the accessibility mirror. React renders the chrome around it and
 * subscribes to {@link ControllerSnapshot}; it never enters the frame loop.
 */

import { Announcer, newLines } from './a11y/announcer';
import {
  createEngineWorker,
  EngineClient,
  type EnginePort,
  loadGhosttyVt,
} from './engine/engine-client';
import type { Frame } from './engine/frame';
import type { EngineSize, SearchState } from './engine/terminal-engine';
import { FocusEscape, keyInput, modsOf, viewKeyAction } from './input/keyboard';
import { linkAt, type TerminalLink, type TerminalLinkTarget } from './links';
import { Canvas2dRenderer } from './render/canvas2d-renderer';
import {
  type CellMetrics,
  type FontSpec,
  measureCell,
} from './render/glyph-atlas';
import type { TerminalRenderer } from './render/renderer';
import { ScreenModel, type TerminalTheme } from './render/screen-model';
import { WebGl2Renderer } from './render/webgl2-renderer';
import type { TerminalViewSession, TerminalViewSessionState } from './session';
import { observeThemeChanges, readTerminalTheme } from './theme';

export interface ControllerSnapshot {
  status: 'loading' | 'ready' | 'error';
  /** Why the engine could not start or stopped; shown with a retry. */
  failure: string | null;
  session: TerminalViewSessionState | 'none';
  title: string;
  hasSelection: boolean;
  atBottom: boolean;
  renderer: 'webgl2' | 'canvas2d' | null;
  search: SearchState | null;
  /** Visible screen text, kept only in screen reader mode. */
  mirror: readonly string[];
  /** Latest polite announcement, kept only in screen reader mode. */
  announcement: string;
  composing: string;
  cursorCss: { left: number; top: number; height: number } | null;
  stickyCtrl: boolean;
  scrollbar: { total: number; offset: number; length: number };
}

export interface ControllerOptions {
  font: FontSpec;
  screenReader: boolean;
  reducedMotion: boolean;
  onLink?(target: TerminalLinkTarget): void;
  onTitle?(title: string): void;
  onBell?(): void;
  /** Called when focus should leave the terminal (Escape then Tab). */
  onFocusLeave?(direction: 'next' | 'previous'): void;
  onContextMenu?(position: { x: number; y: number }): void;
  onFindRequest?(): void;
  /** Test seam: a different worker or wasm source. */
  createWorker?: () => EnginePort;
  wasmUrl?: URL | string;
  /** Test seam: a renderer without a GPU or 2D canvas. */
  createRenderer?: (canvas: HTMLCanvasElement) => TerminalRenderer;
  /** Test seam: cell metrics where no 2D canvas can measure text. */
  measureCell?: typeof measureCell;
}

export interface ControllerElements {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  input: HTMLTextAreaElement;
}

const LONG_PRESS_MS = 450;
const BLINK_MS = 600;

export class TerminalController {
  private snapshot: ControllerSnapshot = {
    status: 'loading',
    failure: null,
    session: 'none',
    title: '',
    hasSelection: false,
    atBottom: true,
    renderer: null,
    search: null,
    mirror: [],
    announcement: '',
    composing: '',
    cursorCss: null,
    stickyCtrl: false,
    scrollbar: { total: 0, offset: 0, length: 0 },
  };
  private readonly listeners = new Set<() => void>();
  private engine: EngineClient | null = null;
  private renderer: TerminalRenderer | null = null;
  private readonly model = new ScreenModel();
  private metrics: CellMetrics | null = null;
  private theme: TerminalTheme | null = null;
  private size: EngineSize | null = null;
  private session: TerminalViewSession | null = null;
  private unsubscribeSession: (() => void) | null = null;
  private readonly cleanups: (() => void)[] = [];
  private pendingFrame: Frame | null = null;
  private rafHandle = 0;
  private visible = true;
  private focused = false;
  private cursorOn = true;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
  private hoverLink: { link: TerminalLink; y: number } | null = null;
  private composing = false;
  private readonly focusEscape = new FocusEscape();
  private pointer: {
    id: number;
    mode: 'select' | 'mouse' | 'scroll';
    lastY: number;
    moved: boolean;
  } | null = null;
  private longPress: ReturnType<typeof setTimeout> | null = null;
  private announcer: Announcer | null = null;
  private previousLines: string[] = [];
  private mirrorTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly elements: ControllerElements,
    private options: ControllerOptions,
  ) {}

  // ─── React bridge ────────────────────────────────────────────────────────

  getSnapshot = (): ControllerSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<ControllerSnapshot>): void {
    const changed = Object.entries(patch).some(
      ([key, value]) => Reflect.get(this.snapshot, key) !== value,
    );
    if (!changed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  // ─── lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.update({ status: 'loading', failure: null });
    try {
      const module = await loadGhosttyVt(this.options.wasmUrl);
      if (this.disposed) return;
      this.theme = readTerminalTheme(this.elements.root);
      this.metrics = (this.options.measureCell ?? measureCell)(
        this.options.font,
        window.devicePixelRatio || 1,
      );
      this.size = this.measureGrid();
      this.renderer = this.createRenderer();
      this.renderer.setTheme(this.theme);
      this.renderer.resize(this.size.cols, this.size.rows, this.metrics);
      const port = (this.options.createWorker ?? createEngineWorker)();
      this.engine = new EngineClient(port, {
        ready: () => this.update({ status: 'ready' }),
        frame: (frame) => this.onFrame(frame),
        output: (bytes, source) => this.toSession(bytes, source),
        bell: () => {
          this.announcer?.event('Bell');
          this.options.onBell?.();
        },
        title: (title) => {
          // Untrusted program text: kept as a string, rendered as text only.
          const clean = [...title]
            .filter((char) => {
              const code = char.charCodeAt(0);
              return code > 0x1f && (code < 0x7f || code > 0x9f);
            })
            .join('')
            .slice(0, 256);
          this.update({ title: clean });
          this.options.onTitle?.(clean);
        },
        error: (message) => this.update({ status: 'error', failure: message }),
      });
      this.engine.send({
        type: 'init',
        module,
        size: this.size,
        theme: this.engineTheme(this.theme),
      });
      this.installListeners();
      this.setScreenReader(this.options.screenReader);
      if (this.session) this.attachSession(this.session);
    } catch (error) {
      this.update({
        status: 'error',
        failure:
          error instanceof Error
            ? error.message
            : 'The terminal could not start.',
      });
    }
  }

  private createRenderer(): TerminalRenderer {
    const callbacks = {
      invalidated: () =>
        this.engine?.send({ type: 'visible', visible: this.visible }),
      failed: () => this.swapToCanvas(),
    };
    if (this.options.createRenderer) {
      const renderer = this.options.createRenderer(this.elements.canvas);
      this.update({ renderer: renderer.kind });
      return renderer;
    }
    const renderer =
      WebGl2Renderer.create(this.elements.canvas, callbacks) ??
      new Canvas2dRenderer(this.elements.canvas);
    this.update({ renderer: renderer.kind });
    return renderer;
  }

  private swapToCanvas(): void {
    this.renderer?.dispose();
    // A canvas that held a WebGL context cannot give a 2D one; replace it.
    const fresh = this.elements.canvas.cloneNode(false) as HTMLCanvasElement;
    this.elements.canvas.replaceWith(fresh);
    this.elements.canvas = fresh;
    this.renderer = new Canvas2dRenderer(fresh);
    if (this.theme) this.renderer.setTheme(this.theme);
    if (this.size && this.metrics)
      this.renderer.resize(this.size.cols, this.size.rows, this.metrics);
    this.update({ renderer: 'canvas2d' });
    this.engine?.send({ type: 'visible', visible: this.visible });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeSession?.();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    if (this.blinkTimer) clearInterval(this.blinkTimer);
    if (this.mirrorTimer) clearTimeout(this.mirrorTimer);
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.announcer?.dispose();
    this.engine?.dispose();
    this.renderer?.dispose();
    this.listeners.clear();
  }

  // ─── session ─────────────────────────────────────────────────────────────

  setSession(session: TerminalViewSession | null): void {
    if (session === this.session) return;
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    this.session = session;
    this.update({ session: session ? session.state : 'none' });
    if (session && this.engine) this.attachSession(session);
  }

  private attachSession(session: TerminalViewSession): void {
    this.unsubscribeSession?.();
    this.unsubscribeSession = session.subscribe({
      output: (bytes, kind) =>
        this.engine?.send({ type: 'write', bytes, mode: kind }, [bytes.buffer]),
      reset: () => this.engine?.send({ type: 'clear' }),
      state: (state, detail) => {
        this.update({ session: state });
        if (state === 'exited')
          this.announcer?.event(
            detail ? `Process exited: ${detail}` : 'Process exited',
          );
      },
    });
    if (this.size && !session.readOnly)
      session.resize(this.size.cols, this.size.rows);
  }

  private toSession(bytes: Uint8Array, source: 'input' | 'reply'): void {
    const session = this.session;
    if (!session || session.readOnly) return;
    // Replies answer live output only; a session that is not ready has no
    // program to receive them.
    if (source === 'reply' && session.state !== 'ready') return;
    session.write(bytes);
  }

  // ─── grid and theme ──────────────────────────────────────────────────────

  private measureGrid(): EngineSize {
    const metrics = this.metrics!;
    const rect = this.elements.root.getBoundingClientRect();
    return {
      cols: Math.max(2, Math.floor(rect.width / metrics.cssWidth)),
      rows: Math.max(1, Math.floor(rect.height / metrics.cssHeight)),
      cellWidth: metrics.width,
      cellHeight: metrics.height,
    };
  }

  private relayout(): void {
    if (!this.metrics || !this.engine || !this.renderer) return;
    const dpr = window.devicePixelRatio || 1;
    if (dpr !== this.metrics.dpr)
      this.metrics = (this.options.measureCell ?? measureCell)(
        this.options.font,
        dpr,
      );
    const next = this.measureGrid();
    const size = this.size;
    if (
      size &&
      size.cols === next.cols &&
      size.rows === next.rows &&
      size.cellWidth === next.cellWidth &&
      size.cellHeight === next.cellHeight
    )
      return;
    this.size = next;
    this.renderer.resize(next.cols, next.rows, this.metrics);
    this.engine.send({ type: 'resize', size: next });
    // Resizes go to the PTY at most every 100ms while a drag is in progress.
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      if (this.session && !this.session.readOnly)
        this.session.resize(next.cols, next.rows);
    }, 100);
  }

  private engineTheme(theme: TerminalTheme) {
    return {
      foreground: theme.foreground,
      background: theme.background,
      cursor: theme.cursor,
      ansi: theme.ansi,
      scheme: theme.scheme,
    };
  }

  private refreshTheme(): void {
    if (!this.engine || !this.renderer) return;
    this.theme = readTerminalTheme(this.elements.root);
    this.renderer.setTheme(this.theme);
    this.engine.send({ type: 'theme', theme: this.engineTheme(this.theme) });
  }

  setFont(font: FontSpec): void {
    this.options = { ...this.options, font };
    if (!this.metrics) return;
    this.metrics = (this.options.measureCell ?? measureCell)(
      font,
      window.devicePixelRatio || 1,
    );
    this.size = null;
    this.relayout();
  }

  // ─── frames ──────────────────────────────────────────────────────────────

  private onFrame(frame: Frame): void {
    if (!this.model.apply(frame)) {
      // A clean row we never saw: ask for everything again.
      this.engine?.send({ type: 'visible', visible: this.visible });
    }
    this.pendingFrame = frame;
    this.update({ atBottom: frame.atBottom, scrollbar: frame.scrollbar });
    this.scheduleDraw();
    if (this.announcer) {
      const lines = this.model.lines();
      const added = newLines(this.previousLines, lines);
      this.previousLines = lines;
      // Output the user typed is echoed; announce only what they did not type.
      if (added.length && !this.focusedTyping) this.announcer.output(added);
      this.focusedTyping = false;
      this.scheduleMirror();
    }
  }

  private focusedTyping = false;

  private scheduleDraw(): void {
    if (this.rafHandle) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = 0;
      this.draw();
      if (this.pendingFrame) {
        this.pendingFrame = null;
        this.engine?.send({ type: 'frame-ack' });
      }
    });
  }

  private draw(): void {
    if (!this.renderer || !this.visible) return;
    this.renderer.render(this.model, {
      focused: this.focused,
      cursorOn: this.cursorOn,
      link: this.hoverLink
        ? [this.hoverLink.y, this.hoverLink.link.start, this.hoverLink.link.end]
        : null,
    });
    const cursor = this.model.cursor;
    const metrics = this.metrics;
    this.update({
      cursorCss:
        cursor && metrics
          ? {
              left: cursor.x * metrics.cssWidth,
              top: cursor.y * metrics.cssHeight,
              height: metrics.cssHeight,
            }
          : null,
    });
  }

  private setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (visible) this.renderer?.resume();
    else this.renderer?.suspend();
    this.engine?.send({ type: 'visible', visible });
  }

  private restartBlink(): void {
    if (this.blinkTimer) clearInterval(this.blinkTimer);
    this.blinkTimer = null;
    this.cursorOn = true;
    if (!this.focused || this.options.reducedMotion) return;
    this.blinkTimer = setInterval(() => {
      if (!this.model.cursor?.blinking) return;
      this.cursorOn = !this.cursorOn;
      this.scheduleDraw();
    }, BLINK_MS);
  }

  // ─── accessibility ───────────────────────────────────────────────────────

  setScreenReader(enabled: boolean): void {
    this.options = { ...this.options, screenReader: enabled };
    if (enabled && !this.announcer) {
      this.announcer = new Announcer((text) =>
        this.update({ announcement: text }),
      );
      this.previousLines = this.model.lines();
      this.scheduleMirror();
    } else if (!enabled && this.announcer) {
      // Off means off: no mirror kept, no diffing, nothing announced.
      this.announcer.dispose();
      this.announcer = null;
      this.previousLines = [];
      this.update({ mirror: [], announcement: '' });
    }
  }

  setReducedMotion(reduced: boolean): void {
    this.options = { ...this.options, reducedMotion: reduced };
    this.restartBlink();
  }

  private scheduleMirror(): void {
    if (this.mirrorTimer || !this.announcer) return;
    this.mirrorTimer = setTimeout(() => {
      this.mirrorTimer = null;
      void this.refreshMirror();
    }, 250);
  }

  /** Scrollback and screen text, built by the emulator from its rows. */
  private async refreshMirror(): Promise<void> {
    if (!this.engine || !this.announcer) return;
    const text = await this.engine.query({ kind: 'plain-text' });
    if (!this.announcer || typeof text !== 'string') return;
    const lines = text.split('\n');
    // Bound the DOM: the last 2,000 lines are navigable line by line.
    this.update({ mirror: lines.slice(-2000) });
  }

  // ─── input ───────────────────────────────────────────────────────────────

  private installListeners(): void {
    const { root, input } = this.elements;
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window | Document,
      type: K | string,
      handler: (event: any) => void,
      options?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, handler, options);
      this.cleanups.push(() =>
        target.removeEventListener(type, handler, options),
      );
    };

    const resizeObserver = new ResizeObserver(() => this.relayout());
    resizeObserver.observe(root);
    this.cleanups.push(() => resizeObserver.disconnect());
    const visibility = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry)
        this.setVisible(
          entry.isIntersecting && document.visibilityState === 'visible',
        );
    });
    visibility.observe(root);
    this.cleanups.push(() => visibility.disconnect());
    on(document, 'visibilitychange', () => {
      const rect = root.getBoundingClientRect();
      this.setVisible(
        document.visibilityState === 'visible' &&
          rect.width > 0 &&
          rect.height > 0,
      );
    });
    this.cleanups.push(observeThemeChanges(() => this.refreshTheme()));
    const dprQuery = () =>
      window.matchMedia?.(`(resolution: ${window.devicePixelRatio}dppx)`);
    let query = dprQuery();
    const onDpr = () => {
      this.relayout();
      query?.removeEventListener?.('change', onDpr);
      query = dprQuery();
      query?.addEventListener?.('change', onDpr);
    };
    query?.addEventListener?.('change', onDpr);
    this.cleanups.push(() => query?.removeEventListener?.('change', onDpr));

    on(input, 'focus', () => {
      this.focused = true;
      this.restartBlink();
      this.engine?.send({ type: 'focus', focused: true });
      this.scheduleDraw();
    });
    on(input, 'blur', () => {
      this.focused = false;
      this.restartBlink();
      this.engine?.send({ type: 'focus', focused: false });
      this.scheduleDraw();
    });
    on(input, 'keydown', (event: KeyboardEvent) => this.onKeyDown(event));
    on(input, 'keyup', (event: KeyboardEvent) => {
      if (
        !this.composing &&
        event.key !== 'Unidentified' &&
        event.keyCode !== 229
      )
        this.engine?.send({ type: 'key', input: keyInput(event, 'release') });
    });
    on(input, 'compositionstart', () => {
      this.composing = true;
      this.update({ composing: '' });
    });
    on(input, 'compositionupdate', (event: CompositionEvent) =>
      this.update({ composing: event.data }),
    );
    on(input, 'compositionend', (event: CompositionEvent) => {
      this.composing = false;
      this.update({ composing: '' });
      if (event.data) this.sendText(event.data);
      input.value = '';
    });
    // Soft keyboards often report key 229/Unidentified and deliver text here.
    on(input, 'beforeinput', (event: InputEvent) => {
      if (this.composing || event.isComposing) return;
      if (event.inputType === 'insertText' && event.data) {
        event.preventDefault();
        this.sendText(event.data);
      } else if (event.inputType === 'insertLineBreak') {
        event.preventDefault();
        this.sendText('\r');
      } else if (event.inputType === 'deleteContentBackward') {
        event.preventDefault();
        this.sendKey('Backspace', 'Backspace');
      }
    });
    on(input, 'paste', (event: ClipboardEvent) => {
      event.preventDefault();
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (text) this.paste(text);
    });

    on(root, 'pointerdown', (event: PointerEvent) => this.onPointerDown(event));
    on(root, 'pointermove', (event: PointerEvent) => this.onPointerMove(event));
    on(root, 'pointerup', (event: PointerEvent) => this.onPointerUp(event));
    on(root, 'pointercancel', () => this.cancelPointer());
    on(root, 'wheel', (event: WheelEvent) => this.onWheel(event), {
      passive: false,
    });
    on(root, 'contextmenu', (event: MouseEvent) => {
      event.preventDefault();
      this.options.onContextMenu?.({ x: event.clientX, y: event.clientY });
    });
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (this.composing || event.isComposing || event.keyCode === 229) return;
    const leave = this.focusEscape.observe(event);
    if (leave) {
      event.preventDefault();
      this.options.onFocusLeave?.(leave === 'focus-next' ? 'next' : 'previous');
      return;
    }
    const action = viewKeyAction(event, this.snapshot.hasSelection);
    if (action) {
      event.preventDefault();
      if (action === 'copy') void this.copy();
      else if (action === 'paste') void this.pasteFromClipboard();
      else if (action === 'find') this.options.onFindRequest?.();
      else if (action === 'select-all') this.selectAll();
      else if (action === 'context-menu') {
        const cursor = this.snapshot.cursorCss;
        const rect = this.elements.root.getBoundingClientRect();
        this.options.onContextMenu?.({
          x: rect.left + (cursor?.left ?? 0),
          y: rect.top + (cursor?.top ?? 0) + (cursor?.height ?? 0),
        });
      }
      return;
    }
    if (
      event.key === 'Shift' ||
      event.key === 'Control' ||
      event.key === 'Alt' ||
      event.key === 'Meta'
    )
      return;
    // Printable keys without modifiers arrive through beforeinput, which also
    // covers soft keyboards; everything else is encoded here.
    const printable = [...event.key].length === 1;
    const sticky = this.snapshot.stickyCtrl;
    if (
      printable &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !sticky
    )
      return;
    event.preventDefault();
    const key = keyInput(event, event.repeat ? 'repeat' : 'press');
    if (sticky) {
      key.mods |= 1 << 1;
      this.update({ stickyCtrl: false });
    }
    this.typed();
    this.engine?.send({ type: 'key', input: key });
  }

  private typed(): void {
    this.focusedTyping = true;
    if (this.snapshot.hasSelection) this.clearSelection();
  }

  /** Committed text (IME, soft keyboard, toolbar). */
  sendText(text: string): void {
    if (!this.session || this.session.readOnly) return;
    if (this.snapshot.stickyCtrl && [...text].length === 1) {
      this.update({ stickyCtrl: false });
      const char = text.toLowerCase();
      const code = /[a-z]/.test(char) ? `Key${char.toUpperCase()}` : '';
      this.engine?.send({
        type: 'key',
        input: {
          code,
          action: 'press',
          mods: 1 << 1,
          text: char,
          unshifted: char.codePointAt(0)!,
        },
      });
      return;
    }
    this.typed();
    this.engine?.send({ type: 'scroll', target: 'bottom' });
    this.session.write(new TextEncoder().encode(text));
  }

  /** A named key (toolbar, soft keyboard) through the key encoder. */
  sendKey(code: string, key: string, mods = 0): void {
    if (!this.session || this.session.readOnly) return;
    this.typed();
    this.engine?.send({
      type: 'key',
      input: {
        code,
        action: 'press',
        mods,
        text: [...key].length === 1 ? key : '',
        unshifted: 0,
      },
    });
  }

  setStickyCtrl(on: boolean): void {
    this.update({ stickyCtrl: on });
  }

  paste(text: string): void {
    if (!this.session || this.session.readOnly) return;
    this.typed();
    this.engine?.send({ type: 'paste', text });
  }

  async pasteFromClipboard(): Promise<boolean> {
    try {
      const text = await navigator.clipboard.readText();
      if (text) this.paste(text);
      return true;
    } catch {
      return false;
    }
  }

  focus(): void {
    this.elements.input.focus({ preventScroll: true });
  }

  // ─── pointer ─────────────────────────────────────────────────────────────

  private cellAt(event: { clientX: number; clientY: number }) {
    const metrics = this.metrics!;
    const rect = this.elements.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const size = this.size!;
    return {
      x: Math.min(
        size.cols - 1,
        Math.max(0, Math.floor(px / metrics.cssWidth)),
      ),
      y: Math.min(
        size.rows - 1,
        Math.max(0, Math.floor(py / metrics.cssHeight)),
      ),
      pixel: { x: px * metrics.dpr, y: py * metrics.dpr },
    };
  }

  private async mouseTracking(
    event: PointerEvent | WheelEvent,
  ): Promise<boolean> {
    // Shift always selects, as in other terminals.
    if (event.shiftKey || !this.engine) return false;
    return (await this.engine.query({ kind: 'mouse-tracking' })) === true;
  }

  private onPointerDown(event: PointerEvent): void {
    if (!this.metrics || !this.size || !this.engine) return;
    if (event.button === 2) return;
    const target = event.target as HTMLElement;
    if (target !== this.elements.canvas && target !== this.elements.root)
      return;
    event.preventDefault();
    this.focus();
    const cell = this.cellAt(event);
    if (event.pointerType === 'touch') {
      // Touch: drag scrolls, a long press starts a selection.
      this.pointer = {
        id: event.pointerId,
        mode: 'scroll',
        lastY: event.clientY,
        moved: false,
      };
      this.longPress = setTimeout(() => {
        if (!this.pointer || this.pointer.moved) return;
        this.pointer.mode = 'select';
        this.engine?.send({
          type: 'select',
          gesture: 'press',
          cell,
          pixel: cell.pixel,
          timeMs: performance.now(),
        });
        this.engine?.send({
          type: 'select',
          gesture: 'press',
          cell,
          pixel: cell.pixel,
          timeMs: performance.now() + 1,
        });
        navigator.vibrate?.(10);
        this.update({ hasSelection: true });
      }, LONG_PRESS_MS);
      return;
    }
    const link = this.linkUnder(cell);
    if (link && (event.ctrlKey || event.metaKey)) {
      this.options.onLink?.(link.target);
      return;
    }
    this.elements.root.setPointerCapture(event.pointerId);
    this.pointer = {
      id: event.pointerId,
      mode: 'select',
      lastY: event.clientY,
      moved: false,
    };
    void this.mouseTracking(event).then((tracking) => {
      if (!this.pointer || this.pointer.id !== event.pointerId) return;
      if (tracking) {
        this.pointer.mode = 'mouse';
        this.sendMouse('press', event, cell.pixel);
      } else {
        this.engine?.send({
          type: 'select',
          gesture: 'press',
          cell,
          pixel: cell.pixel,
          timeMs: event.timeStamp,
        });
        this.refreshSelectionState();
      }
    });
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.metrics || !this.size) return;
    const cell = this.cellAt(event);
    const pointer = this.pointer;
    if (!pointer || pointer.id !== event.pointerId) {
      this.updateHover(event, cell);
      return;
    }
    if (pointer.mode === 'scroll') {
      const dy = event.clientY - pointer.lastY;
      if (Math.abs(dy) > 4) {
        pointer.moved = true;
        if (this.longPress) clearTimeout(this.longPress);
      }
      const rows = Math.trunc(dy / this.metrics.cssHeight);
      if (rows !== 0) {
        pointer.lastY += rows * this.metrics.cssHeight;
        this.engine?.send({ type: 'scroll', target: { delta: -rows } });
      }
      return;
    }
    pointer.moved = true;
    if (pointer.mode === 'mouse') this.sendMouse('motion', event, cell.pixel);
    else
      this.engine?.send({
        type: 'select',
        gesture: 'drag',
        cell,
        pixel: cell.pixel,
        timeMs: event.timeStamp,
      });
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.longPress) clearTimeout(this.longPress);
    const pointer = this.pointer;
    this.pointer = null;
    if (!pointer || pointer.id !== event.pointerId || !this.metrics) return;
    const cell = this.cellAt(event);
    if (pointer.mode === 'mouse') this.sendMouse('release', event, cell.pixel);
    else if (pointer.mode === 'select') {
      this.engine?.send({
        type: 'select',
        gesture: 'release',
        cell,
        pixel: cell.pixel,
        timeMs: event.timeStamp,
      });
      this.refreshSelectionState();
    } else if (!pointer.moved && event.pointerType === 'touch') {
      // A tap on a link opens it; any other tap focuses (soft keyboard).
      const link = this.linkUnder(cell);
      if (link) this.options.onLink?.(link.target);
    }
  }

  private cancelPointer(): void {
    if (this.longPress) clearTimeout(this.longPress);
    this.pointer = null;
  }

  private sendMouse(
    action: 'press' | 'release' | 'motion',
    event: PointerEvent,
    pixel: { x: number; y: number },
  ): void {
    const button =
      action === 'motion' && event.buttons === 0
        ? 0
        : event.button === 1
          ? 3
          : event.button === 2
            ? 2
            : 1;
    this.engine?.send({
      type: 'mouse',
      input: { action, button, x: pixel.x, y: pixel.y, mods: modsOf(event) },
    });
  }

  private onWheel(event: WheelEvent): void {
    if (!this.metrics) return;
    event.preventDefault();
    const lines =
      event.deltaMode === 1
        ? event.deltaY
        : event.deltaMode === 2
          ? event.deltaY * (this.size?.rows ?? 24)
          : event.deltaY / this.metrics.cssHeight;
    const rows = Math.trunc(lines) || Math.sign(lines);
    if (!rows) return;
    const cell = this.cellAt(event);
    void this.mouseTracking(event).then((tracking) => {
      if (tracking) {
        // Wheel as buttons 4 (up) and 5 (down), one report per row.
        for (let i = 0; i < Math.min(Math.abs(rows), 10); i += 1)
          this.engine?.send({
            type: 'mouse',
            input: {
              action: 'press',
              button: rows < 0 ? 4 : 5,
              x: cell.pixel.x,
              y: cell.pixel.y,
              mods: modsOf(event),
            },
          });
      } else this.engine?.send({ type: 'scroll', target: { delta: rows } });
    });
  }

  private linkUnder(cell: { x: number; y: number }) {
    const row = this.model.rows[cell.y];
    if (!row) return null;
    return linkAt(row, cell.x);
  }

  private updateHover(
    event: PointerEvent,
    cell: { x: number; y: number },
  ): void {
    const link =
      event.pointerType === 'mouse' && (event.ctrlKey || event.metaKey)
        ? this.linkUnder(cell)
        : null;
    const next = link ? { link, y: cell.y } : null;
    const same =
      (next === null && this.hoverLink === null) ||
      (next &&
        this.hoverLink &&
        next.y === this.hoverLink.y &&
        next.link.start === this.hoverLink.link.start);
    this.elements.root.style.cursor = link ? 'pointer' : 'text';
    if (same) return;
    this.hoverLink = next;
    this.scheduleDraw();
  }

  /** The link under a viewport cell, including OSC 8 hyperlinks. */
  async linkAtCell(x: number, y: number): Promise<TerminalLinkTarget | null> {
    const row = this.model.rows[y];
    const detected = row ? linkAt(row, x) : null;
    if (detected) return detected.target;
    const uri = await this.engine?.query({ kind: 'hyperlink', x, y });
    if (typeof uri !== 'string') return null;
    try {
      const url = new URL(uri);
      return url.protocol === 'http:' || url.protocol === 'https:'
        ? { kind: 'url', url: url.href }
        : null;
    } catch {
      return null;
    }
  }

  // ─── selection, find, actions ────────────────────────────────────────────

  private refreshSelectionState(): void {
    void this.engine?.query({ kind: 'selection-text' }).then((text) =>
      this.update({
        hasSelection: typeof text === 'string' && text.length > 0,
      }),
    );
  }

  async selectionText(): Promise<string> {
    const text = await this.engine?.query({ kind: 'selection-text' });
    return typeof text === 'string' ? text : '';
  }

  async copy(): Promise<boolean> {
    const text = await this.selectionText();
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  selectAll(): void {
    this.engine?.send({ type: 'select-all' });
    this.update({ hasSelection: true });
  }

  clearSelection(): void {
    this.engine?.send({ type: 'clear-selection' });
    this.update({ hasSelection: false });
  }

  clear(): void {
    this.engine?.send({ type: 'clear' });
  }

  scrollToBottom(): void {
    this.engine?.send({ type: 'scroll', target: 'bottom' });
  }

  scrollTo(row: number): void {
    this.engine?.send({ type: 'scroll', target: { row } });
  }

  async find(
    needle: string,
    direction: 'next' | 'prev' | 'same',
  ): Promise<SearchState> {
    const state = (await this.engine?.query({
      kind: 'find',
      needle,
      direction,
    })) ?? {
      total: 0,
      selected: -1,
    };
    this.update({
      search: needle ? state : null,
      hasSelection: state.selected >= 0,
    });
    return state;
  }
}
