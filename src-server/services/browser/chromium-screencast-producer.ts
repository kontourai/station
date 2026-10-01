/**
 * A live-surface producer over one Chromium page target (#90): the page's
 * CDP screencast is the frame stream, and CDP `Input.*` is the input channel.
 *
 * It speaks only through the host's GUARDED `cdp()` channel, so it can reach
 * nothing the page-session allowlist does not already permit. It meets the
 * producer contract in `../live-surface/producer.ts`:
 *
 * - JavaScript dialogs never wedge input. A page whose click handler calls
 *   `alert()` leaves `Input.dispatchMouseEvent` pending until the dialog
 *   closes. A dialog is answered here the moment it opens (dismissed;
 *   `beforeunload` accepted) UNLESS `holdDialog` says a person is in control:
 *   then an `alert`/`confirm`/`prompt` is held for that person to answer
 *   (`answerDialog`), the input that opened it settles at once instead of
 *   waiting on the dialog, and further activating input is refused until it
 *   is answered. A held dialog nobody answers is answered automatically after
 *   `dialogHoldMs`. Each automatic answer is reported (`onDialog`) so the
 *   session's action history keeps it discoverable (D6); a person's answer is
 *   recorded by whoever called `answerDialog`.
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
import { jpegSize } from '../live-surface/jpeg-size.js';
import {
  type LiveSurfaceHeldInput,
  LiveSurfaceInputRefusal,
  type LiveSurfaceProducer,
} from '../live-surface/producer.js';
import type { CdpTransport } from './browser-host.js';
import { CdpProtocolError } from './cdp-pipe-transport.js';

/** One JavaScript dialog the producer answered on the page's behalf. */
export interface HandledJavaScriptDialog {
  type: string;
  /** The dialog's text, bounded. */
  message: string;
  url?: string;
  /** Whether it was accepted (only `beforeunload`) or dismissed. */
  accepted: boolean;
  /** Held for a person, and answered automatically because nobody did. */
  unanswered?: true;
  /**
   * Held for a person, and dismissed automatically because their control
   * ended (released or lapsed) before they answered.
   */
  controlEnded?: true;
}

/** The dialog types a person can be asked to answer. */
export type HeldJavaScriptDialogType = 'alert' | 'confirm' | 'prompt';

/** A dialog held open for a person to answer (see `holdDialog`). */
export interface PendingJavaScriptDialog {
  /** Names this one dialog; an answer for any other is refused. */
  dialogId: string;
  type: HeldJavaScriptDialogType;
  /** The dialog's text, bounded. */
  message: string;
  /** A prompt's pre-filled answer, bounded. */
  defaultPrompt?: string;
  /** When it opened (`now()`, ms). */
  openedAt: number;
}

export type AnswerDialogResult =
  | { ok: true; dialog: PendingJavaScriptDialog }
  | { ok: false; code: 'no-dialog' | 'page-busy' | 'browser-error' };

/**
 * Input refused because a held dialog is waiting for a person. A
 * `LiveSurfaceInputRefusal`, so the viewer is told `page-dialog-open`
 * rather than a generic dispatch failure.
 */
export class ChromiumScreencastDialogPendingError extends LiveSurfaceInputRefusal {
  constructor() {
    super(
      'page-dialog-open',
      'The page is showing a dialog that is waiting for an answer.',
    );
    this.name = 'ChromiumScreencastDialogPendingError';
  }
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
  /**
   * Whether a person should answer this dialog: asked when it opens. False
   * (the default) answers it automatically, which is what an agent's input
   * and an unwatched page get. Only `alert`, `confirm` and `prompt` are ever
   * held: `beforeunload` is always accepted (someone asked to navigate).
   */
  holdDialog?: (dialog: { type: HeldJavaScriptDialogType }) => boolean;
  /** How long a held dialog waits for a person before its automatic answer. */
  dialogHoldMs?: number;
  /** A held dialog opened or closed (answered, timed out, navigated away). */
  onPendingDialogChange?: (dialog: PendingJavaScriptDialog | null) => void;
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
  defaultPrompt?: string;
}

const DEFAULT_DISPATCH_TIMEOUT_MS = 5_000;
/** Bound on a dialog's text in the history (and the automatic report). */
const DIALOG_MESSAGE_MAX = 300;
/** Bound on a held dialog's text and default answer shown to a person. */
export const PENDING_DIALOG_TEXT_MAX = 2_000;
/** A held dialog nobody answers is answered automatically after this. */
const DEFAULT_DIALOG_HOLD_MS = 120_000;
const HELD_DIALOG_TYPES: ReadonlySet<string> = new Set([
  'alert',
  'confirm',
  'prompt',
]);
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
  private readonly offDialogClosed: () => void;
  private readonly dialogHoldMs: number;
  private pending: PendingJavaScriptDialog | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private dialogSeq = 0;
  /** The person's answer in flight, and whether the page closed it meanwhile. */
  private answering: {
    dialogId: string;
    closed: boolean;
    released: boolean;
  } | null = null;
  /** Input calls waiting on CDP; a held dialog opening settles them. */
  private readonly dialogWaiters = new Set<() => void>();
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
    this.dialogHoldMs = options.dialogHoldMs ?? DEFAULT_DIALOG_HOLD_MS;
    this.offDialog = this.cdp.on(
      'Page.javascriptDialogOpening',
      (params, sessionId) => {
        if (sessionId !== this.session) return;
        this.onDialogOpening((params ?? {}) as DialogOpeningEvent);
      },
    );
    // Closed by anyone (our answer, or the page navigating away): a held
    // dialog that is gone must not stay on anyone's screen.
    this.offDialogClosed = this.cdp.on(
      'Page.javascriptDialogClosed',
      (_params, sessionId) => {
        if (sessionId !== this.session) return;
        // An answer in flight must not restore a dialog that is gone.
        if (this.answering) this.answering.closed = true;
        if (!this.pending) return;
        this.clearPending();
      },
    );
  }

  /**
   * The person the dialog was held for no longer holds control: dismiss it
   * now (reported as `controlEnded`), so the page is not left modal with
   * nobody answering and an agent blocked behind it.
   */
  releaseHeldDialog(): void {
    // An answer in flight must not bring the dialog back as held for
    // someone who no longer holds control.
    if (this.answering) this.answering.released = true;
    const dialog = this.pending;
    if (!dialog) return;
    this.clearPending();
    this.answerAutomatically(
      { type: dialog.type, message: dialog.message },
      'control-ended',
    );
  }

  /** The dialog held for a person right now, if any (a copy). */
  pendingDialog(): PendingJavaScriptDialog | null {
    return this.pending ? { ...this.pending } : null;
  }

  /**
   * A person's answer to the held dialog `dialogId`. Refused (`no-dialog`)
   * when that dialog is no longer the one held: answered already, timed out,
   * or replaced. `promptText` is used only for a prompt.
   */
  async answerDialog(
    dialogId: string,
    answer: { accept: boolean; promptText?: string },
  ): Promise<AnswerDialogResult> {
    const dialog = this.pending;
    if (!dialog || dialog.dialogId !== dialogId)
      return { ok: false, code: 'no-dialog' };
    // While the answer is in flight the dialog is nobody's to auto-answer:
    // its hold timer stops (a fresh one is armed if the answer fails).
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pending = null;
    const answering = { dialogId, closed: false, released: false };
    this.answering = answering;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const sent = this.cdp.send(
      'Page.handleJavaScriptDialog',
      {
        accept: answer.accept,
        ...(dialog.type === 'prompt' && answer.accept
          ? { promptText: answer.promptText ?? '' }
          : {}),
      },
      this.session,
    );
    try {
      const outcome = await Promise.race([
        sent.then(
          () => ({ kind: 'answered' as const }),
          (error: unknown) => ({ kind: 'refused' as const, error }),
        ),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          deadline = setTimeout(
            () => resolve({ kind: 'timeout' }),
            this.dispatchTimeoutMs,
          );
        }),
      ]);
      if (outcome.kind === 'answered') {
        this.reportPending(null);
        return { ok: true, dialog };
      }
      // The browser says there is no such dialog (the page navigated away,
      // or it closed): nothing is left to answer.
      if (outcome.kind === 'refused' && isNoDialogShowing(outcome.error)) {
        this.reportPending(null);
        return { ok: false, code: 'no-dialog' };
      }
      // No answer in time, or the channel itself failed: the dialog may
      // still be showing, so it stays held (with a FRESH hold timer) unless
      // the page closed it while the answer was in flight.
      // If the person's control ended meanwhile (or nobody person holds it
      // now), it is dismissed as their control ending would have done.
      const stillTheirs =
        !answering.released && this.personStillHolds(dialog.type);
      if (!answering.closed && !this.pending && !this.disposed && stillTheirs) {
        this.pending = dialog;
        this.armHoldTimer(dialog);
      } else {
        this.reportPending(null);
        if (!answering.closed && !this.disposed && !stillTheirs)
          this.answerAutomatically(
            { type: dialog.type, message: dialog.message },
            'control-ended',
          );
      }
      return {
        ok: false,
        code: outcome.kind === 'timeout' ? 'page-busy' : 'browser-error',
      };
    } finally {
      if (deadline) clearTimeout(deadline);
      if (this.answering === answering) this.answering = null;
      sent.catch(() => {});
    }
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
    if (this.pending) {
      // The page is modal: CDP would hold this input until the dialog closes.
      // A hover or scroll is dropped; anything that would act is refused, so
      // the person sees it was not delivered and answers the dialog first.
      if (
        input.kind === 'pointer' &&
        (input.type === 'move' || input.type === 'wheel')
      )
        return;
      throw new ChromiumScreencastDialogPendingError();
    }
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
    this.offDialogClosed();
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pending = null;
    this.releaseDialogWaiters();
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

  /**
   * One CDP input call, bounded by the dispatch timeout. A dialog held for a
   * person while it is pending settles it: the input was delivered (it
   * opened the dialog), and CDP answers it only once the dialog closes.
   */
  private async send(method: string, params: object): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waiter: (() => void) | undefined;
    const pending = this.cdp.send(method, params, this.session);
    try {
      await Promise.race([
        pending,
        new Promise<void>((resolve) => {
          waiter = resolve;
          this.dialogWaiters.add(resolve);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new ChromiumScreencastDispatchTimeoutError(method)),
            this.dispatchTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (waiter) this.dialogWaiters.delete(waiter);
      // A late settlement after the timeout must not surface as unhandled.
      pending.catch(() => {});
    }
  }

  private releaseDialogWaiters(): void {
    const waiters = [...this.dialogWaiters];
    this.dialogWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private clearPending(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    if (!this.pending) return;
    this.pending = null;
    this.reportPending(null);
  }

  private reportPending(dialog: PendingJavaScriptDialog | null): void {
    try {
      this.options.onPendingDialogChange?.(dialog ? { ...dialog } : null);
    } catch (error) {
      this.options.onError?.('pending dialog report failed', error);
    }
  }

  /** Whether a dialog of `type` would be held for a person right now. */
  private personStillHolds(type: HeldJavaScriptDialogType): boolean {
    try {
      return this.options.holdDialog?.({ type }) === true;
    } catch {
      return false;
    }
  }

  /** The held dialog's automatic answer, `dialogHoldMs` from now. */
  private armHoldTimer(dialog: PendingJavaScriptDialog): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      if (this.pending?.dialogId !== dialog.dialogId) return;
      this.pending = null;
      this.pendingTimer = null;
      this.reportPending(null);
      this.answerAutomatically(
        { type: dialog.type, message: dialog.message },
        'unanswered',
      );
    }, this.dialogHoldMs);
    this.pendingTimer.unref?.();
  }

  private onDialogOpening(event: DialogOpeningEvent): void {
    const type = typeof event.type === 'string' ? event.type : 'unknown';
    let hold = false;
    if (HELD_DIALOG_TYPES.has(type) && !this.disposed) {
      try {
        hold =
          this.options.holdDialog?.({
            type: type as HeldJavaScriptDialogType,
          }) === true;
      } catch (error) {
        this.options.onError?.('dialog hold decision failed', error);
      }
    }
    if (!hold) {
      this.answerAutomatically(event);
      return;
    }
    // One dialog at a time per page: a page cannot open a second while the
    // first is showing, so a stale record is simply replaced.
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.dialogSeq += 1;
    const dialog: PendingJavaScriptDialog = {
      dialogId: `d${this.dialogSeq}`,
      type: type as HeldJavaScriptDialogType,
      message:
        typeof event.message === 'string'
          ? event.message.slice(0, PENDING_DIALOG_TEXT_MAX)
          : '',
      ...(type === 'prompt' && typeof event.defaultPrompt === 'string'
        ? {
            defaultPrompt: event.defaultPrompt.slice(
              0,
              PENDING_DIALOG_TEXT_MAX,
            ),
          }
        : {}),
      openedAt: this.now(),
    };
    this.pending = dialog;
    this.armHoldTimer(dialog);
    this.reportPending(dialog);
    // The input that opened it was delivered; it must not wait on a person.
    this.releaseDialogWaiters();
  }

  private onScreencastFrame(
    event: ScreencastFrameEvent,
    onFrame: (header: LiveSurfaceFrameHeader, body: Uint8Array) => void,
  ): void {
    if (typeof event?.data !== 'string' || !Number.isInteger(event.sessionId))
      return;
    const body = new Uint8Array(Buffer.from(event.data, 'base64'));
    const size = jpegSize(body);
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

  private answerAutomatically(
    event: DialogOpeningEvent,
    heldEnded?: 'unanswered' | 'control-ended',
  ): void {
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
        ...(heldEnded === 'unanswered' ? { unanswered: true as const } : {}),
        ...(heldEnded === 'control-ended'
          ? { controlEnded: true as const }
          : {}),
      });
    } catch (error) {
      this.options.onError?.('dialog report failed', error);
    }
  }
}

/**
 * Chromium's own answer to handling a dialog that is not there ("No dialog
 * is showing"), as opposed to the channel failing.
 */
function isNoDialogShowing(error: unknown): boolean {
  return (
    error instanceof CdpProtocolError &&
    /no dialog is showing/i.test(error.protocolMessage)
  );
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
