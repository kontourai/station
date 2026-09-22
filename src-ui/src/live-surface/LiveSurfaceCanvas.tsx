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
}

/** Heartbeats arrive every ~5 s; two missed ones is a stall worth saying. */
export const LIVE_SURFACE_STALL_MS = 12_000;
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
  tone: 'you' | 'agent' | 'other' | 'none';
} {
  const holder = surface.lease?.holder;
  if (!holder)
    return {
      text: 'No one is in control. Interacting takes control.',
      tone: 'none',
    };
  if (holder.kind === 'agent')
    return {
      text: 'An agent is in control. Interacting takes control from it.',
      tone: 'agent',
    };
  if (surface.selfPrincipal && holder.principal === surface.selfPrincipal)
    return { text: 'You are in control.', tone: 'you' };
  return {
    text: 'Another person is in control. Interacting takes control.',
    tone: 'other',
  };
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
  const canInteract = surface.status === 'live' && frameSize !== null;

  // A once-a-second clock for the honest age line, only while it can matter.
  const [clock, setClock] = useState(() => now());
  useEffect(() => {
    if (surface.status !== 'live' && surface.status !== 'reconnecting') return;
    const timer = setInterval(() => setClock(now()), 1_000);
    return () => clearInterval(timer);
  }, [surface.status, now]);

  const toSurface = useCallback((clientX: number, clientY: number) => {
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
    );
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
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
    const input: LiveSurfaceInput = {
      kind: 'pointer',
      type: 'down',
      ...point,
      clickCount: count,
    };
    const button = buttonOf(event.button);
    if (button) input.button = button;
    const modifiers = modifiersOf(event);
    if (modifiers) input.modifiers = modifiers;
    sendInput([input]);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = toSurface(event.clientX, event.clientY);
    if (!point) return;
    const input: LiveSurfaceInput = {
      kind: 'pointer',
      type: 'up',
      ...point,
      clickCount: lastDownRef.current?.count ?? 1,
    };
    const button = buttonOf(event.button);
    if (button) input.button = button;
    const modifiers = modifiersOf(event);
    if (modifiers) input.modifiers = modifiers;
    sendInput([input]);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = toSurface(event.clientX, event.clientY);
    if (!point) return;
    const input: LiveSurfaceInput = { kind: 'pointer', type: 'move', ...point };
    const modifiers = modifiersOf(event);
    if (modifiers) input.modifiers = modifiers;
    sendInput([input]);
  };

  // Wheel needs a non-passive listener to keep the host page from scrolling.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
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
    event.preventDefault();
    const input: LiveSurfaceInput = {
      kind: 'key',
      type,
      key: event.key,
      code: event.code,
    };
    const modifiers = modifiersOf(event);
    if (modifiers) input.modifiers = modifiers;
    sendInput([input]);
  };

  const onKeyboardInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent as InputEvent;
    const target = event.currentTarget;
    if (composingRef.current || native.isComposing) return;
    if (target.value) sendInput([{ kind: 'text', text: target.value }]);
    target.value = '';
  };

  const onCompositionEnd = (
    event: ReactCompositionEvent<HTMLTextAreaElement>,
  ) => {
    composingRef.current = false;
    if (event.data) sendInput([{ kind: 'text', text: event.data }]);
    event.currentTarget.value = '';
  };

  const controller = controllerLine(surface);
  const recordAge = secondsAgo(clock, surface.lastRecordAt);
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
      <div className="live-surface__toolbar">
        <p
          className={`live-surface__controller live-surface__controller--${controller.tone}`}
          aria-live="polite"
        >
          {controller.text}
        </p>
        {controller.tone !== 'you' && surface.status === 'live' ? (
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
          readOnly={!canInteract}
          onKeyDown={(event) => sendKey('down', event)}
          onKeyUp={(event) => sendKey('up', event)}
          onInput={onKeyboardInput}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={onCompositionEnd}
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
