import type {
  LiveSurfaceFrameHeader,
  LiveSurfaceInput,
  LiveSurfaceModifiers,
  LiveSurfacePointerButton,
  LiveSurfaceStreamParams,
} from '@kontourai/station-contracts/live-surface';
import type { authenticatedFetch } from '@kontourai/station-sdk';
import {
  type FormEvent,
  type CompositionEvent as ReactCompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Button } from '../components/Button';
import { mapClientPointToSurface } from './liveSurfaceGeometry';
import {
  type LiveSurfaceFrame,
  type UseLiveSurfaceResult,
  useLiveSurface,
} from './useLiveSurface';
import './LiveSurfaceCanvas.css';

/**
 * A live surface drawn to a canvas (#90), shared by the Browser pane and,
 * later, the Device pane.
 *
 * What it claims, and only that:
 * - who is in control right now (the lease the server published);
 * - whether the stream is connected — "Reconnecting" when it is not, and
 *   "last update N s ago" only when the stream has gone silent, measured on
 *   THIS client's clock. A still page sends no new frames; the server's
 *   heartbeat is what separates "nothing changed" from "stream stalled", so
 *   an old frame on a live stream is not reported as stale.
 *
 * Input: the canvas takes pointer and wheel; a visually hidden textarea
 * over it takes focus and receives keys, text and IME composition, which a
 * canvas cannot. Tab is left to the host page so keyboard focus can leave.
 *
 * Who may take control, and how (#90 D9, orchestrator decision): any human
 * input the server accepts claims the lease, so what this canvas SENDS is
 * what decides whether passing over it steals control from an agent.
 * - A hover move (no button held) and a wheel scroll never claim: they are
 *   sent only while this viewer already holds control. Moving the pointer
 *   across an agent's page, or scrolling the chat past it, takes nothing.
 * - A press (pointer down), a key down and typed text are the claiming
 *   interactions, and whatever they started (the drag, the release) follows.
 * - With `inputRequiresLease` even those are withheld until this viewer
 *   holds control through an explicit Take control, and the keyboard target
 *   leaves the tab order until then (the float-over-chat, which can sit
 *   under the pointer and in the tab order without anyone meaning to drive).
 */

export interface LiveSurfaceCanvasProps {
  apiBase: string;
  surfaceId: string;
  /** Accessible name of the surface, e.g. "Browser: example.com". */
  label: string;
  params?: Partial<LiveSurfaceStreamParams>;
  /** Test seam; defaults to the SDK's `authenticatedFetch`. */
  transport?: typeof authenticatedFetch;
  now?: () => number;
  /**
   * The host draws the control line and "Take control" itself (the
   * float-over-chat's pill, #90 D9), so the canvas omits its own copy of
   * both. Everything else — status, notices, input — is unchanged.
   */
  hostControls?: boolean;
  /**
   * Who controls the surface and how to take control, as this canvas's one
   * stream reports it. A host that shows control state reads it here rather
   * than opening a second stream for the same lease (ADR 0018 budget).
   */
  onControlState?: (state: LiveSurfaceControlState) => void;
  /**
   * No input at all — not even a click or a key — until this viewer holds
   * control (through `claimControl`, the host's Take control). For a
   * surface that can sit under the pointer or in the tab order without
   * anyone meaning to drive it.
   */
  inputRequiresLease?: boolean;
}

/** What a host needs to show and change who controls the surface. */
export interface LiveSurfaceControlState {
  status: UseLiveSurfaceResult['status'];
  tone: LiveSurfaceControllerTone;
  claimControl: () => Promise<void>;
}

export type LiveSurfaceControllerTone = 'you' | 'agent' | 'other' | 'none';

/** Heartbeats arrive every ~5 s; two missed ones is a stall worth saying. */
const LIVE_SURFACE_STALL_MS = 12_000;
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SLOP_PX = 4;

function modifiersOf(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): LiveSurfaceModifiers | undefined {
  const modifiers: LiveSurfaceModifiers = {};
  if (event.altKey) modifiers.alt = true;
  if (event.ctrlKey) modifiers.ctrl = true;
  if (event.metaKey) modifiers.meta = true;
  if (event.shiftKey) modifiers.shift = true;
  return Object.keys(modifiers).length > 0 ? modifiers : undefined;
}

/** Mouse is the default on the wire; only touch and pen are named. */
function pointerTypeOf(event: { pointerType?: string }): {
  pointerType?: 'touch' | 'pen';
} {
  return event.pointerType === 'touch' || event.pointerType === 'pen'
    ? { pointerType: event.pointerType }
    : {};
}

function buttonOf(button: number): LiveSurfacePointerButton | undefined {
  if (button === 0) return 'left';
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return undefined;
}

/** A printable key without a shortcut modifier arrives as text instead. */
function isTextKey(event: ReactKeyboardEvent): boolean {
  return (
    [...event.key].length === 1 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  );
}

function controllerLine(surface: UseLiveSurfaceResult): {
  text: string;
  tone: LiveSurfaceControllerTone;
} {
  const holder = surface.lease?.holder;
  if (!holder)
    return {
      text: 'No one is in control. Click or type to take control.',
      tone: 'none',
    };
  if (holder.kind === 'agent')
    return {
      text: 'An agent is in control. Click or type to take control from it.',
      tone: 'agent',
    };
  // Identity comes from the server (each viewer's state record names it),
  // never from which principal this client last saw win a claim.
  const self = surface.self;
  if (self && holder.principal === self.principal) {
    if (holder.device === self.device)
      return { text: 'You are in control.', tone: 'you' };
    return {
      text: 'You are in control from another device. Click or type here to take control.',
      tone: 'other',
    };
  }
  return {
    text: 'Another person is in control. Click or type to take control.',
    tone: 'other',
  };
}

/** This viewer (principal AND device) holds control, per the server. */
function holdsControl(surface: UseLiveSurfaceResult): boolean {
  const holder = surface.lease?.holder;
  const self = surface.self;
  return (
    holder?.kind === 'human' &&
    !!self &&
    holder.principal === self.principal &&
    holder.device === self.device
  );
}

function secondsAgo(now: number, at: number | null): number | null {
  return at === null ? null : Math.max(0, Math.floor((now - at) / 1000));
}

export function LiveSurfaceCanvas(props: LiveSurfaceCanvasProps) {
  const { label, now = Date.now } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  const headerRef = useRef<LiveSurfaceFrameHeader | null>(null);
  const [frameSize, setFrameSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const decodingRef = useRef(false);
  const nextFrameRef = useRef<LiveSurfaceFrame | null>(null);
  const composingRef = useRef(false);
  const lastDownRef = useRef<{
    at: number;
    x: number;
    y: number;
    count: number;
  } | null>(null);

  const draw = useCallback(async (frame: LiveSurfaceFrame) => {
    // Latest-frame-wins in the client too: while one frame decodes, only the
    // newest waiting frame is kept.
    if (decodingRef.current) {
      nextFrameRef.current = frame;
      return;
    }
    decodingRef.current = true;
    let current: LiveSurfaceFrame | null = frame;
    while (current) {
      const { header, body } = current;
      const canvas = canvasRef.current;
      if (canvas) {
        if (canvas.width !== header.width) canvas.width = header.width;
        if (canvas.height !== header.height) canvas.height = header.height;
        headerRef.current = header;
        setFrameSize((previous) =>
          previous?.width === header.width && previous.height === header.height
            ? previous
            : { width: header.width, height: header.height },
        );
        if (typeof createImageBitmap === 'function') {
          try {
            const bitmap = await createImageBitmap(
              new Blob([body.slice()], { type: `image/${header.codec}` }),
            );
            canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
            bitmap.close?.();
          } catch {
            // An undecodable frame is skipped; the next one replaces it.
          }
        }
      }
      current = nextFrameRef.current;
      nextFrameRef.current = null;
    }
    decodingRef.current = false;
  }, []);

  const surface = useLiveSurface({
    apiBase: props.apiBase,
    surfaceId: props.surfaceId,
    params: props.params,
    visibilityRef: containerRef,
    onFrame: (frame) => void draw(frame),
    transport: props.transport,
    now,
  });
  const { sendInput } = surface;
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;
  const canInteract = surface.status === 'live' && frameSize !== null;
  const holding = holdsControl(surface);
  /** A claiming interaction may be sent: always, unless the host requires the lease first. */
  const mayClaim = () =>
    !props.inputRequiresLease || holdsControl(surfaceRef.current);

  // A once-a-second clock for the honest age line, only while it can matter.
  const [clock, setClock] = useState(() => now());
  useEffect(() => {
    if (surface.status !== 'live' && surface.status !== 'reconnecting') return;
    const timer = setInterval(() => setClock(now()), 1_000);
    return () => clearInterval(timer);
  }, [surface.status, now]);

  /** Buttons this pointer holds down on the surface, and where it last was. */
  const heldRef = useRef(new Set<LiveSurfacePointerButton>());
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const heldPointerTypeRef = useRef<{ pointerType?: 'touch' | 'pen' }>({});
  /** Keys this client pressed (as key events) and has not released. */
  const heldKeysRef = useRef(new Map<string, { key: string; code: string }>());

  const toSurface = useCallback(
    (clientX: number, clientY: number, clamp = false) => {
      const canvas = canvasRef.current;
      const header = headerRef.current;
      if (!canvas || !header) return null;
      const rect = canvas.getBoundingClientRect();
      return mapClientPointToSurface(
        { x: clientX, y: clientY },
        {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
        header,
        { clamp },
      );
    },
    [],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!mayClaim()) return;
    const point = toSurface(event.clientX, event.clientY);
    keyboardRef.current?.focus({ preventScroll: true });
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const at = now();
    const last = lastDownRef.current;
    const count =
      last &&
      at - last.at <= DOUBLE_CLICK_MS &&
      Math.abs(last.x - point.x) <= DOUBLE_CLICK_SLOP_PX &&
      Math.abs(last.y - point.y) <= DOUBLE_CLICK_SLOP_PX
        ? Math.min(3, last.count + 1)
        : 1;
    lastDownRef.current = { at, x: point.x, y: point.y, count };
    lastPointRef.current = point;
    heldPointerTypeRef.current = pointerTypeOf(event);
    const input: LiveSurfaceInput = {
      kind: 'pointer',
      type: 'down',
      ...point,
      clickCount: count,
      ...pointerTypeOf(event),
    };
    const button = buttonOf(event.button);
    if (button) {
      input.button = button;
      heldRef.current.add(button);
    }
    const modifiers = modifiersOf(event);
    if (modifiers) input.modifiers = modifiers;
    sendInput([input]);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const button = buttonOf(event.button);
    const held = button !== undefined && heldRef.current.has(button);
    // Only the release of a press this client sent, or any release while it
    // holds control: a stray up is input too, and input claims.
    if (!held && !holdsControl(surfaceRef.current)) return;
    // A release of a held button must reach the surface wherever it happens
    // (pointer capture keeps delivering it here): clamp, don't drop.
    const point = toSurface(event.clientX, event.clientY, held);
    if (!point) return;
    if (button) heldRef.current.delete(button);
    lastPointRef.current = point;
    const input: LiveSurfaceInput = {
      kind: 'pointer',
      type: 'up',
      ...point,
      clickCount: lastDownRef.current?.count ?? 1,
      ...pointerTypeOf(event),
    };
    if (button) input.button = button;
    const modifiers = modifiersOf(event);
    if (modifiers) input.modifiers = modifiers;
    sendInput([input]);
  };

  /**
   * This client is about to stop seeing its own input's release (focus
   * left, the page was hidden or is being unloaded): release everything it
   * holds NOW, as ordinary ups, while it still holds control. Otherwise the
   * surface keeps a key or button down until the server's hold ceiling. If
   * it no longer holds control there is nothing to send: the server
   * cancelled its presses at the handoff.
   */
  const releaseEverything = () => {
    const current = surfaceRef.current;
    const holder = current.lease?.holder;
    const self = current.self;
    const holding =
      holder?.kind === 'human' &&
      !!self &&
      holder.principal === self.principal &&
      holder.device === self.device;
    const keys = [...heldKeysRef.current.values()];
    heldKeysRef.current.clear();
    if (!holding) {
      heldRef.current.clear();
      return;
    }
    releaseHeld();
    if (keys.length > 0)
      sendInput(
        keys.map(({ key, code }) => ({ kind: 'key', type: 'up', key, code })),
      );
  };
  const releaseEverythingRef = useRef(releaseEverything);
  releaseEverythingRef.current = releaseEverything;
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') releaseEverythingRef.current();
    };
    const onPageHide = () => releaseEverythingRef.current();
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, []);

  /** The gesture was taken away (cancel, lost capture): release what's held. */
  const releaseHeld = () => {
    const point = lastPointRef.current;
    if (!point || heldRef.current.size === 0) return;
    const events: LiveSurfaceInput[] = [...heldRef.current].map((button) => ({
      kind: 'pointer',
      type: 'up',
      ...point,
      button,
      clickCount: 1,
      ...heldPointerTypeRef.current,
    }));
    heldRef.current.clear();
    sendInput(events);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    // A hover (no button this client pressed) is sent only while it already
    // holds control: passing the pointer over the surface claims nothing.
    if (heldRef.current.size === 0 && !holdsControl(surfaceRef.current)) return;
    const point = toSurface(
      event.clientX,
      event.clientY,
      heldRef.current.size > 0,
    );
    if (!point) return;
    lastPointRef.current = point;
    const input: LiveSurfaceInput = {
      kind: 'pointer',
      type: 'move',
      ...point,
      ...pointerTypeOf(event),
    };
    const modifiers = modifiersOf(event);
    if (modifiers) input.modifiers = modifiers;
    sendInput([input]);
  };

  // Wheel needs a non-passive listener to keep the host page from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      // Scrolling never claims: without control the wheel is the host
      // page's (the chat scrolls past the surface), not the surface's.
      if (!holdsControl(surfaceRef.current)) return;
      const point = toSurface(event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? canvas.clientHeight
            : 1;
      const input: LiveSurfaceInput = {
        kind: 'pointer',
        type: 'wheel',
        ...point,
        deltaX: event.deltaX * unit,
        deltaY: event.deltaY * unit,
      };
      const modifiers = modifiersOf(event);
      if (modifiers) input.modifiers = modifiers;
      sendInput([input]);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [toSurface, sendInput]);

  const sendKey = (type: 'down' | 'up', event: ReactKeyboardEvent) => {
    if (
      !canInteract ||
      event.key === 'Tab' ||
      composingRef.current ||
      event.key === 'Process'
    )
      return;
    if (isTextKey(event)) return; // delivered by the input event as text
    const id = event.code || event.key;
    // A key down claims (unless the host requires the lease first); a key up
    // goes only for a key this client pressed, or while it holds control.
    if (
      type === 'down'
        ? !mayClaim()
        : !heldKeysRef.current.has(id) && !holdsControl(surfaceRef.current)
    )
      return;
    event.preventDefault();
    const input: LiveSurfaceInput = {
      kind: 'key',
      type,
      key: event.key,
      code: event.code,
    };
    const modifiers = modifiersOf(event);
    if (modifiers) input.modifiers = modifiers;
    if (type === 'down')
      heldKeysRef.current.set(id, { key: event.key, code: event.code });
    else heldKeysRef.current.delete(id);
    sendInput([input]);
  };

  const onKeyboardInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent as InputEvent;
    const target = event.currentTarget;
    if (composingRef.current || native.isComposing) return;
    if (target.value && mayClaim())
      sendInput([{ kind: 'text', text: target.value }]);
    target.value = '';
  };

  const onCompositionEnd = (
    event: ReactCompositionEvent<HTMLTextAreaElement>,
  ) => {
    composingRef.current = false;
    if (event.data && mayClaim())
      sendInput([{ kind: 'text', text: event.data }]);
    event.currentTarget.value = '';
  };

  const controller = controllerLine(surface);
  const { onControlState } = props;
  const { status, claimControl } = surface;
  const tone = controller.tone;
  useEffect(() => {
    onControlState?.({ status, tone, claimControl });
  }, [onControlState, status, tone, claimControl]);
  const recordAge = secondsAgo(clock, surface.lastActivityAt);
  const frameAge = secondsAgo(clock, surface.lastFrameAt);
  let statusText: string | null = null;
  if (surface.status === 'connecting') statusText = 'Connecting…';
  else if (surface.status === 'reconnecting')
    statusText =
      frameAge === null
        ? 'Reconnecting…'
        : `Reconnecting… The frame shown is ${frameAge} s old.`;
  else if (surface.status === 'suspended')
    statusText = 'Paused while this pane is hidden.';
  else if (surface.status === 'unavailable')
    statusText = 'This surface is not available.';
  else if (surface.status === 'denied')
    statusText = 'You do not have permission to view this surface.';
  else if (
    surface.status === 'live' &&
    recordAge !== null &&
    recordAge * 1000 >= LIVE_SURFACE_STALL_MS
  )
    statusText = `The stream has stalled. The frame shown is ${frameAge ?? recordAge} s old.`;

  return (
    <div className="live-surface" ref={containerRef}>
      {/* With host controls the toolbar is left only for "Try again". */}
      {props.hostControls &&
      surface.status !== 'unavailable' &&
      surface.status !== 'denied' ? null : (
        <div className="live-surface__toolbar">
          {props.hostControls ? null : (
            <p
              className={`live-surface__controller live-surface__controller--${controller.tone}`}
              aria-live="polite"
            >
              {controller.text}
            </p>
          )}
          <div className="live-surface__actions">
            {!props.hostControls &&
            controller.tone !== 'you' &&
            surface.status === 'live' ? (
              <Button
                size="sm"
                className="live-surface__claim"
                onClick={() => void surface.claimControl()}
              >
                Take control
              </Button>
            ) : null}
            {surface.status === 'unavailable' || surface.status === 'denied' ? (
              <Button
                size="sm"
                className="live-surface__claim"
                onClick={surface.retry}
              >
                Try again
              </Button>
            ) : null}
          </div>
        </div>
      )}
      {surface.wedged && surface.status === 'live' ? (
        <p className="live-surface__notice" role="status">
          The page is not responding to input (it may be showing a dialog).
        </p>
      ) : null}
      {surface.inputNotice === 'control-changed' ? (
        <p className="live-surface__notice" role="status">
          Control changed before your input arrived, so it was not sent.
        </p>
      ) : surface.inputNotice === 'input-failed' ? (
        <p className="live-surface__notice" role="status">
          Your input could not be delivered.
        </p>
      ) : null}
      <div className="live-surface__stage">
        <canvas
          ref={canvasRef}
          className="live-surface__canvas"
          role="img"
          aria-label={`Live view of ${label}`}
          data-testid="live-surface-canvas"
          onPointerDown={canInteract ? onPointerDown : undefined}
          onPointerUp={canInteract ? onPointerUp : undefined}
          onPointerMove={canInteract ? onPointerMove : undefined}
          onPointerCancel={releaseHeld}
          onLostPointerCapture={releaseHeld}
          onContextMenu={(event) => event.preventDefault()}
        />
        <textarea
          ref={keyboardRef}
          className="live-surface__keyboard"
          aria-label={`Keyboard input for ${label}`}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          readOnly={!canInteract || (props.inputRequiresLease && !holding)}
          // Out of the tab order until this viewer may drive: tabbing through
          // a floated surface must not land keys on an agent's page.
          tabIndex={props.inputRequiresLease && !holding ? -1 : undefined}
          onKeyDown={(event) => sendKey('down', event)}
          onKeyUp={(event) => sendKey('up', event)}
          onInput={onKeyboardInput}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={onCompositionEnd}
          onBlur={() => releaseEverything()}
        />
        {statusText ? (
          <p className="live-surface__status" role="status">
            {statusText}
          </p>
        ) : null}
      </div>
    </div>
  );
}
