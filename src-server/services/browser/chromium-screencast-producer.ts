/**
 * A live-surface producer over one Chromium page target (#90): the page's
 * CDP screencast is the frame stream, and CDP `Input.*` is the input channel.
 *
 * It speaks only through the host's GUARDED `cdp()` channel, so it can reach
 * nothing the page-session allowlist does not already permit. It meets the
 * producer contract in `../live-surface/producer.ts`:
 *
 * - JavaScript dialogs are answered here, the moment they open. A page whose
 *   click handler calls `alert()` leaves `Input.dispatchMouseEvent` pending
 *   until the dialog closes; nobody can see a headless dialog, so input must
 *   never wait on one. Each dialog is reported (`onDialog`) so the session's
 *   action history keeps it discoverable (D6).
 * - Every dispatch is bounded by its own timeout, so a stuck CDP call can
 *   wedge the surface for at most that long, never forever.
 * - Held input is cancelled in the modality it was pressed in: a touch as a
 *   `touchCancel` (no tap), a mouse button by moving off the page first and
 *   releasing there (no click on the pressed element), keys by their `up`.
 *
 * Stopping the stream never closes the page, and `dispatch` works whether or
 * not the stream is running (an agent may drive a page nobody watches).
 */
import type {
  LiveSurfaceFrameHeader,
  LiveSurfaceInput,
  LiveSurfaceModifiers,
  LiveSurfacePointerButton,
  LiveSurfaceStreamParams,
} from '@kontourai/station-contracts/live-surface';
import {
  LIVE_SURFACE_DEVICE_SCALE_FACTOR_MAX,
  LIVE_SURFACE_DEVICE_SCALE_FACTOR_MIN,
} from '@kontourai/station-contracts/live-surface';
import type {
  LiveSurfaceHeldInput,
  LiveSurfaceProducer,
} from '../live-surface/producer.js';
import type { CdpTransport } from './browser-host.js';

/** One JavaScript dialog the producer answered on the page's behalf. */
export interface HandledJavaScriptDialog {
  type: string;
  /** The dialog's text, bounded. */
  message: string;
  url?: string;
  /** Whether it was accepted (only `beforeunload`) or dismissed. */
  accepted: boolean;
}

export interface ChromiumScreencastProducerOptions {
  surfaceId: string;
  /** The host's guarded channel. */
  cdp: CdpTransport;
  /** The page target's CDP session. */
  cdpSessionId: string;
  /** Bound on each CDP input call. */
  dispatchTimeoutMs?: number;
  onDialog?: (dialog: HandledJavaScriptDialog) => void;
  /** Called for every input dispatched into the page (not held-input cancels). */
  onInput?: (input: LiveSurfaceInput) => void;
  onError?: (message: string, error: unknown) => void;
  now?: () => number;
}

interface ScreencastFrameEvent {
  data: string;
  sessionId: number;
  metadata: {
    deviceWidth?: number;
    deviceHeight?: number;
    pageScaleFactor?: number;
    timestamp?: number;
  };
}

interface DialogOpeningEvent {
  type?: string;
  message?: string;
  url?: string;
}

const DEFAULT_DISPATCH_TIMEOUT_MS = 5_000;
const DIALOG_MESSAGE_MAX = 300;
/** Off every viewport: a release here completes no click. */
const OFF_PAGE = { x: -1, y: -1 } as const;

const BUTTON_BITS: Record<LiveSurfacePointerButton, number> = {
  left: 1,
  right: 2,
  middle: 4,
};

/**
 * Windows virtual key codes for the non-printable keys a viewer sends as
 * `key` events. Without one, Chromium does not run the key's default action
 * (Enter does not submit, Backspace does not delete).
 */
const VIRTUAL_KEY_CODES: Readonly<Record<string, number>> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
  ContextMenu: 93,
  F1: 112,
  F2: 113,
  F3: 114,
  F4: 115,
  F5: 116,
  F6: 117,
  F7: 118,
  F8: 119,
  F9: 120,
  F10: 121,
  F11: 122,
  F12: 123,
};

function virtualKeyCode(key: string, code: string): number | undefined {
  const known = VIRTUAL_KEY_CODES[key];
  if (known !== undefined) return known;
  // The key the layout produced, not the physical position: on AZERTY the
  // physical KeyQ types "a", and a shortcut means the letter it typed.
  if (/^[A-Za-z0-9]$/.test(key)) return key.toUpperCase().charCodeAt(0);
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!.charCodeAt(0);
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1]!.charCodeAt(0);
  return undefined;
}

/** CDP modifier bit field: Alt=1, Ctrl=2, Meta=4, Shift=8. */
function modifierBits(modifiers: LiveSurfaceModifiers | undefined): number {
  if (!modifiers) return 0;
  return (
    (modifiers.alt ? 1 : 0) |
    (modifiers.ctrl ? 2 : 0) |
    (modifiers.meta ? 4 : 0) |
    (modifiers.shift ? 8 : 0)
  );
}

/**
 * Width and height of a baseline or progressive JPEG, read from its first
 * start-of-frame marker; undefined when the bytes are not a JPEG we can read.
 */
export function jpegDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    // Fill bytes between markers.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Standalone markers carry no length.
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) return undefined;
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (offset + 9 > bytes.length) return undefined;
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}

/**
 * Image pixels per surface pixel, where a surface pixel is a CSS pixel of the
 * page's LAYOUT viewport — the unit `Input.dispatchMouseEvent` and
 * `Input.dispatchTouchEvent` take.
 *
 * The screencast draws the visual viewport: `deviceWidth` device-independent
 * pixels scaled into `imageWidth` image pixels. The page's own zoom
 * (`pageScaleFactor`) sits between those and CSS pixels: a mobile page with
 * no `<meta name=viewport>` lays out at 980 CSS px and is shown zoomed out
 * to ~0.4, so one DIP is 1/0.4 CSS px. Leaving it out sends every tap on such
 * a page to the wrong place. Undefined when it cannot be derived or falls
 * outside the wire bounds.
 */
export function screencastDeviceScaleFactor(
  imageWidth: number,
  deviceWidth: number | undefined,
  pageScaleFactor = 1,
): number | undefined {
  if (
    typeof deviceWidth !== 'number' ||
    !Number.isFinite(deviceWidth) ||
    deviceWidth <= 0 ||
    imageWidth <= 0 ||
    !Number.isFinite(pageScaleFactor) ||
    pageScaleFactor <= 0
  )
    return undefined;
  const ratio = (imageWidth / deviceWidth) * pageScaleFactor;
  if (
    ratio < LIVE_SURFACE_DEVICE_SCALE_FACTOR_MIN ||
    ratio > LIVE_SURFACE_DEVICE_SCALE_FACTOR_MAX
  )
    return undefined;
  return ratio;
}

export class ChromiumScreencastDispatchTimeoutError extends Error {
  constructor(readonly method: string) {
    super(`${method} did not settle in time`);
    this.name = 'ChromiumScreencastDispatchTimeoutError';
  }
}

export class ChromiumScreencastProducer implements LiveSurfaceProducer {
  readonly surfaceId: string;
  readonly capabilities = {
    codecs: ['jpeg'] as const,
    input: ['pointer', 'key', 'text'] as const,
  };
  private readonly cdp: CdpTransport;
  private readonly session: string;
  private readonly dispatchTimeoutMs: number;
  private readonly now: () => number;
  private readonly offDialog: () => void;
  private offFrame: (() => void) | null = null;
  private seq = 0;
  /** seq → the screencast frame's own ack id. */
  private readonly pendingAcks = new Map<number, number>();
  private params: LiveSurfaceStreamParams | null = null;
  /** Mouse buttons currently held, as a CDP `buttons` bit field. */
  private heldButtons = 0;
  private touchActive = false;
  private disposed = false;

  constructor(private readonly options: ChromiumScreencastProducerOptions) {
    this.surfaceId = options.surfaceId;
    this.cdp = options.cdp;
    this.session = options.cdpSessionId;
    this.dispatchTimeoutMs =
      options.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    // Subscribed for the producer's whole life, not only while streaming: an
    // agent's input can open a dialog with no viewer attached.
    this.offDialog = this.cdp.on(
      'Page.javascriptDialogOpening',
      (params, sessionId) => {
        if (sessionId !== this.session) return;
        this.answerDialog(params as DialogOpeningEvent);
      },
    );
  }

  async start(
    params: LiveSurfaceStreamParams,
    onFrame: (header: LiveSurfaceFrameHeader, body: Uint8Array) => void,
  ): Promise<void> {
    this.offFrame?.();
    this.pendingAcks.clear();
    this.offFrame = this.cdp.on('Page.screencastFrame', (raw, sessionId) => {
      if (sessionId !== this.session) return;
      this.onScreencastFrame(raw as ScreencastFrameEvent, onFrame);
    });
    this.params = { ...params };
    try {
      await this.cdp.send(
        'Page.startScreencast',
        screencastParams(params),
        this.session,
      );
    } catch (error) {
      this.offFrame?.();
      this.offFrame = null;
      this.params = null;
      throw error;
    }
  }

  ack(seq: number): void {
    const frameSession = this.pendingAcks.get(seq);
    if (frameSession === undefined) return;
    this.pendingAcks.delete(seq);
    this.cdp
      .send(
        'Page.screencastFrameAck',
        { sessionId: frameSession },
        this.session,
      )
      .catch((error: unknown) =>
        this.options.onError?.('screencast frame ack failed', error),
      );
  }

  async stop(): Promise<void> {
    this.offFrame?.();
    this.offFrame = null;
    this.pendingAcks.clear();
    this.params = null;
    await this.cdp
      .send('Page.stopScreencast', {}, this.session)
      .catch((error: unknown) =>
        this.options.onError?.('screencast stop failed', error),
      );
  }

  async updateParams(params: LiveSurfaceStreamParams): Promise<void> {
    if (!this.params) return;
    const current = this.params;
    this.params = { ...params };
    // fps is enforced by the hub; only a size or quality change restarts.
    if (
      current.quality === params.quality &&
      current.maxWidth === params.maxWidth &&
      current.maxHeight === params.maxHeight
    )
      return;
    await this.cdp.send('Page.stopScreencast', {}, this.session);
    this.pendingAcks.clear();
    await this.cdp.send(
      'Page.startScreencast',
      screencastParams(params),
      this.session,
    );
  }

  async dispatch(input: LiveSurfaceInput): Promise<void> {
    try {
      this.options.onInput?.(input);
    } catch (error) {
      this.options.onError?.('input report failed', error);
    }
    if (input.kind === 'text') {
      await this.send('Input.insertText', { text: input.text });
      return;
    }
    if (input.kind === 'key') {
      await this.dispatchKey(
        input.type,
        input.key,
        input.code,
        input.modifiers,
      );
      return;
    }
    if (input.kind !== 'pointer') {
      // Narrowed explicitly: an input kind this producer does not declare in
      // `capabilities.input` is refused, never read as a pointer.
      throw new Error(
        `The browser surface does not take ${(input as { kind: string }).kind} input.`,
      );
    }
    if (input.type === 'wheel') {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: input.x,
        y: input.y,
        deltaX: input.deltaX ?? 0,
        deltaY: input.deltaY ?? 0,
        modifiers: modifierBits(input.modifiers),
        buttons: this.heldButtons,
      });
      return;
    }
    if (input.pointerType === 'touch') {
      await this.dispatchTouch(input.type, input.x, input.y, input.modifiers);
      return;
    }
    const button = input.button;
    if (input.type === 'down' && button)
      this.heldButtons |= BUTTON_BITS[button];
    if (input.type === 'up' && button) this.heldButtons &= ~BUTTON_BITS[button];
    await this.send('Input.dispatchMouseEvent', {
      type:
        input.type === 'down'
          ? 'mousePressed'
          : input.type === 'up'
            ? 'mouseReleased'
            : 'mouseMoved',
      x: input.x,
      y: input.y,
      button: input.type === 'move' ? 'none' : (button ?? 'left'),
      buttons: this.heldButtons,
      clickCount: input.type === 'move' ? 0 : (input.clickCount ?? 1),
      modifiers: modifierBits(input.modifiers),
      ...(input.pointerType === 'pen' ? { pointerType: 'pen' } : {}),
    });
  }

  async cancelHeldInput(held: LiveSurfaceHeldInput): Promise<void> {
    const touchButtons = held.buttons.filter(
      (button) =>
        (held.buttonPointerTypes[button] ?? held.pointerType) === 'touch',
    );
    const mouseButtons = held.buttons.filter(
      (button) => !touchButtons.includes(button),
    );
    const failures: unknown[] = [];
    const attempt = async (run: () => Promise<void>) => {
      try {
        await run();
      } catch (error) {
        failures.push(error);
      }
    };
    if (touchButtons.length > 0 || this.touchActive) {
      this.touchActive = false;
      // Ends the gesture without a tap.
      await attempt(() =>
        this.send('Input.dispatchTouchEvent', {
          type: 'touchCancel',
          touchPoints: [],
        }),
      );
    }
    if (mouseButtons.length > 0) {
      // Leave the page with the buttons still down, THEN release: a release
      // over the pressed element would complete the click being cancelled.
      await attempt(() =>
        this.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          ...OFF_PAGE,
          button: 'none',
          buttons: this.heldButtons,
        }),
      );
      for (const button of mouseButtons) {
        this.heldButtons &= ~BUTTON_BITS[button];
        await attempt(() =>
          this.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            ...OFF_PAGE,
            button,
            buttons: this.heldButtons,
            clickCount: 1,
          }),
        );
      }
    }
    for (const { key, code } of held.keys)
      await attempt(() => this.dispatchKey('up', key, code, undefined));
    if (failures.length > 0) throw failures[0];
  }

  /** Stop listening for dialogs. The page itself is the host's to close. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offDialog();
    this.offFrame?.();
    this.offFrame = null;
    this.pendingAcks.clear();
  }

  private async dispatchKey(
    type: 'down' | 'up',
    key: string,
    code: string,
    modifiers: LiveSurfaceModifiers | undefined,
  ): Promise<void> {
    const keyCode = virtualKeyCode(key, code);
    const bits = modifierBits(modifiers);
    // Enter carries its text so a form submits; printable characters arrive
    // as `text` input instead. Never `commands`: the host refuses them.
    const text =
      type === 'down' && key === 'Enter' && (bits & (2 | 4)) === 0
        ? '\r'
        : undefined;
    await this.send('Input.dispatchKeyEvent', {
      type: type === 'up' ? 'keyUp' : text ? 'keyDown' : 'rawKeyDown',
      key,
      code,
      modifiers: bits,
      ...(keyCode !== undefined
        ? { windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
        : {}),
      ...(text ? { text, unmodifiedText: text } : {}),
    });
  }

  private async dispatchTouch(
    type: 'down' | 'up' | 'move',
    x: number,
    y: number,
    modifiers: LiveSurfaceModifiers | undefined,
  ): Promise<void> {
    if (type === 'move' && !this.touchActive) return;
    if (type === 'down') this.touchActive = true;
    if (type === 'up') this.touchActive = false;
    await this.send('Input.dispatchTouchEvent', {
      type:
        type === 'down'
          ? 'touchStart'
          : type === 'up'
            ? 'touchEnd'
            : 'touchMove',
      touchPoints: type === 'up' ? [] : [{ x, y, id: 0 }],
      modifiers: modifierBits(modifiers),
    });
  }

  /** One CDP input call, bounded by the dispatch timeout. */
  private async send(method: string, params: object): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = this.cdp.send(method, params, this.session);
    try {
      await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new ChromiumScreencastDispatchTimeoutError(method)),
            this.dispatchTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      // A late settlement after the timeout must not surface as unhandled.
      pending.catch(() => {});
    }
  }

  private onScreencastFrame(
    event: ScreencastFrameEvent,
    onFrame: (header: LiveSurfaceFrameHeader, body: Uint8Array) => void,
  ): void {
    if (typeof event?.data !== 'string' || !Number.isInteger(event.sessionId))
      return;
    const body = new Uint8Array(Buffer.from(event.data, 'base64'));
    const size = jpegDimensions(body);
    const pageScale = event.metadata?.pageScaleFactor;
    const deviceScaleFactor = size
      ? screencastDeviceScaleFactor(
          size.width,
          event.metadata?.deviceWidth,
          typeof pageScale === 'number' ? pageScale : 1,
        )
      : undefined;
    if (!size || deviceScaleFactor === undefined) {
      // A frame we cannot place is dropped, but still acked: an unacked
      // frame stops the screencast for good.
      this.cdp
        .send(
          'Page.screencastFrameAck',
          { sessionId: event.sessionId },
          this.session,
        )
        .catch(() => {});
      this.options.onError?.('screencast frame dropped: unreadable size', {
        surfaceId: this.surfaceId,
      });
      return;
    }
    this.seq += 1;
    const seq = this.seq;
    this.pendingAcks.set(seq, event.sessionId);
    const timestamp = event.metadata?.timestamp;
    onFrame(
      {
        surfaceId: this.surfaceId,
        seq,
        // The hub overwrites the epoch from the lease.
        epoch: 0,
        codec: 'jpeg',
        width: size.width,
        height: size.height,
        deviceScaleFactor,
        capturedAt:
          typeof timestamp === 'number' && Number.isFinite(timestamp)
            ? Math.round(timestamp * 1000)
            : this.now(),
      },
      body,
    );
  }

  private answerDialog(event: DialogOpeningEvent): void {
    // `beforeunload` is accepted: dismissing it would silently cancel the
    // navigation someone asked for. Every other dialog is dismissed.
    const accepted = event?.type === 'beforeunload';
    this.cdp
      .send('Page.handleJavaScriptDialog', { accept: accepted }, this.session)
      .catch((error: unknown) =>
        this.options.onError?.(
          'javascript dialog could not be answered',
          error,
        ),
      );
    try {
      this.options.onDialog?.({
        type: typeof event?.type === 'string' ? event.type : 'unknown',
        message:
          typeof event?.message === 'string'
            ? event.message.slice(0, DIALOG_MESSAGE_MAX)
            : '',
        ...(typeof event?.url === 'string' ? { url: event.url } : {}),
        accepted,
      });
    } catch (error) {
      this.options.onError?.('dialog report failed', error);
    }
  }
}

function screencastParams(params: LiveSurfaceStreamParams) {
  return {
    format: 'jpeg',
    quality: params.quality,
    maxWidth: params.maxWidth,
    maxHeight: params.maxHeight,
    everyNthFrame: 1,
  };
}
