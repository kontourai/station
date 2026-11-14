import type {
  LiveSurfaceFrameHeader,
  LiveSurfaceFrameRotation,
  LiveSurfaceInput,
  LiveSurfaceModifiers,
  LiveSurfacePointerButton,
  LiveSurfaceStreamParams,
} from '@kontourai/station-contracts/live-surface';
import type { authenticatedFetch } from '@kontourai/station-sdk';
import {
  type CSSProperties,
  type FormEvent,
  type CompositionEvent as ReactCompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Button } from '../components/Button';
import { ExpandGlyph, MoreGlyph } from '../components/icons/Glyph';
import { Empty, ErrorState } from '../components/state';
import { useCoarsePointer } from '../hooks/useCoarsePointer';
import { useNarrowViewport } from '../hooks/useNarrowViewport';
import { useConstrainedNetwork } from '../platform/networkCost';
import { AgentActionOverlay } from './AgentActionOverlay';
import {
  CONTROLS_AUTO_HIDE_MS,
  DRIVER_TEXT,
  isKeyboardFocus,
  LiveSurfaceViewerControls,
  useAutoHide,
} from './LiveSurfaceViewerControls';
import { mapClientPointToSurface } from './liveSurfaceGeometry';
import {
  liveSurfaceStreamBudget,
  useSteppedPixelBox,
} from './liveSurfaceStreamBudget';
import {
  LiveSurfaceH264Decoder,
  liveSurfaceH264Offered,
} from './liveSurfaceVideoDecoder';
import {
  clampSurfaceZoom,
  pinchSurfaceZoom,
  SURFACE_ZOOM_FIT,
  type SurfaceZoom,
  scaleSurfaceZoomAt,
  settleSurfaceZoom,
  surfaceZoomTransform,
  type ZoomPoint,
} from './liveSurfaceZoom';
import { useImmersive } from './useImmersive';
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
 *
 * Touch (viewing, never input): two fingers pinch-zoom and pan the PICTURE
 * (`liveSurfaceZoom`); a double tap while zoomed returns to fit. So that a
 * pinch never lands a press on the page, a one-finger press is held back
 * until it is clearly not the start of one: it goes out when the finger
 * lifts (a tap), moves past a slop (a drag), or stays down past a short
 * hold. A second finger before then cancels it, and nothing was sent.
 *
 * Immersive (`useImmersive`): the same element, laid over the whole viewport
 * (and the platform's full screen where granted), with the shared viewer
 * chrome revealed on tap and hidden again after a few seconds.
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
  /** The Project the surface is reached from (see `useLiveSurface`). */
  projectSlug?: string;
  /**
   * Optional (added by the Device pane lane, #1970): a host's own chrome,
   * rendered above the controller line and given the surface — so a toolbar
   * of hardware buttons sends its input through THIS surface's lease and
   * disables itself exactly when this canvas stops taking input.
   */
  renderHeader?: (surface: LiveSurfaceHeaderApi) => ReactNode;
  /**
   * Optional (Device pane lane): size the drawn surface to the LARGEST box
   * that fits the stage at the frame's aspect ratio (a ResizeObserver on the
   * stage), instead of filling the stage and letterboxing inside it. Before
   * the first frame the box uses `aspect` (width / height). `cornerRadius`
   * rounds that box, in CSS pixels, from its measured size.
   */
  fit?: {
    aspect: number;
    cornerRadius?: (box: { width: number; height: number }) => number;
  };
  /**
   * Optional (added by the Device tools lane, #1971; fit mode only): a layer
   * drawn exactly over the drawn frame's box — never taking pointers — and
   * given the SHOWN frame's size and the rotation it was drawn with, so an
   * overlay (the accessibility frames) can line up with a turned screen.
   * `visible` is true only while the stream is live.
   */
  renderOverlay?: (geometry: LiveSurfaceOverlayGeometry) => ReactNode;
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
  /** Dimensions of the most recently drawn frame, after rotation. */
  onFrameSize?: (size: { width: number; height: number }) => void;
  /**
   * The producer's status (input/video liveness, orientation, a foldable's
   * `fold`) whenever it changes, in every mode: unlike `renderHeader`, this
   * keeps reporting while the surface is full screen.
   */
  onProducerStatus?: (status: UseLiveSurfaceResult['producerStatus']) => void;
  /**
   * No input at all — not even a click or a key — until this viewer holds
   * control (through `claimControl`, the host's Take control). For a
   * surface that can sit under the pointer or in the tab order without
   * anyone meaning to drive it. Lifted in immersive mode: there the person
   * chose to drive, and a touch on the surface is input.
   */
  inputRequiresLease?: boolean;
  /** This viewer may watch but must not send input. */
  readOnly?: boolean;
  agentActionsEnabled?: boolean;
  /**
   * Drawn over the stage, unzoomed, and kept in immersive mode: a page's
   * held dialog belongs over the live view wherever the view is.
   */
  overlay?: ReactNode;
  /**
   * The per-surface extension point of the full-screen bar: what this kind
   * of surface adds to the shared chrome (a browser's navigation, a
   * device's hardware buttons), given the same surface API as
   * `renderHeader` so its input goes through this surface's lease.
   */
  renderImmersiveActions?: (surface: LiveSurfaceHeaderApi) => ReactNode;
  /**
   * The surface's secondary full-screen controls: in the bar's row when it
   * has room, behind its More controls button at phone width.
   */
  renderImmersiveMenu?: (surface: LiveSurfaceHeaderApi) => ReactNode;
  /** Told when this surface enters or leaves full screen. */
  onImmersiveChange?: (immersive: boolean) => void;
  /** Ask for a foldable's fold state (a device viewer that can draw it). */
  acceptFold?: boolean;
  /** A Full screen button on the stage (a pane; the float has its pill). */
  fullScreenButton?: boolean;
  /**
   * Optional (foldable devices; fit mode only): draw the frame through a
   * host-owned presentation instead of flat. The canvas stays the input
   * target, invisible, and `toFrame` maps a client point on it to the
   * SHOWN frame's pixels (null where the presentation shows nothing). The
   * shared viewer's other hosts (fullscreen, float) pass the same object.
   */
  projection?: LiveSurfaceProjection;
}

/** What a `projection` gives the canvas. */
export interface LiveSurfaceProjection {
  toFrame(
    client: { x: number; y: number },
    box: { left: number; top: number; width: number; height: number },
    shown: { width: number; height: number },
  ): { x: number; y: number } | null;
  /** Drawn over the canvas box; repaints from `source` after each frame. */
  render(source: LiveSurfaceProjectionSource): ReactNode;
  /**
   * The box's aspect (width / height) for this shown frame, when the
   * projection draws it differently (turned a quarter to fit a screen).
   */
  fitAspect?(shown: { width: number; height: number }): number;
}

/** The drawn frame a projection copies from. */
export interface LiveSurfaceProjectionSource {
  canvas: HTMLCanvasElement | null;
  shown: { width: number; height: number };
  /** Called after every frame is drawn; returns an unsubscribe. */
  subscribe(onDrawn: () => void): () => void;
}

/** What `renderOverlay` receives. */
export interface LiveSurfaceOverlayGeometry {
  /** The frame as shown (axes swapped on a quarter turn), in frame pixels. */
  shown: { width: number; height: number };
  /** The clockwise turn the canvas drew the raw frame with. */
  rotation: LiveSurfaceFrameRotation;
  visible: boolean;
}

/** What `renderHeader` receives. */
export interface LiveSurfaceHeaderApi {
  surface: UseLiveSurfaceResult;
  /**
   * Input would be delivered right now: the stream is live, the surface is
   * not wedged, and the producer's input channel (when it reports one) is
   * connected. Controls that send input are disabled while this is false.
   */
  inputReady: boolean;
  sendInput: (events: LiveSurfaceInput[]) => void;
}

/** A frame turned by `rotation` is shown with its axes swapped on a quarter turn. */
function shownSize(header: {
  width: number;
  height: number;
  rotation?: LiveSurfaceFrameRotation;
}): { width: number; height: number } {
  return header.rotation === 90 || header.rotation === 270
    ? { width: header.height, height: header.width }
    : { width: header.width, height: header.height };
}

/** The largest box of `aspect` (w/h) that fits inside `box`. */
function largestBoxAtAspect(
  box: { width: number; height: number },
  aspect: number,
): { width: number; height: number } {
  if (box.width <= 0 || box.height <= 0 || !(aspect > 0))
    return { width: 0, height: 0 };
  const width = Math.min(box.width, box.height * aspect);
  return { width, height: width / aspect };
}

/** What a host needs to show and change who controls the surface. */
export interface LiveSurfaceControlState {
  status: UseLiveSurfaceResult['status'];
  tone: LiveSurfaceControllerTone;
  claimControl: () => Promise<void>;
  /** Give control up explicitly (only meaningful while `tone` is `you`). */
  releaseControl: () => Promise<void>;
  /** Keep this person's hold alive (capped by the server; not input). */
  keepControlAlive: () => Promise<void>;
  /** The surface fills the screen (see `useImmersive`). */
  immersive: boolean;
  enterImmersive: () => void;
  exitImmersive: () => void;
}

export type LiveSurfaceControllerTone = 'you' | 'agent' | 'other' | 'none';

/** Heartbeats arrive every ~5 s; two missed ones is a stall worth saying. */
const LIVE_SURFACE_STALL_MS = 12_000;
/** A failed H.264 decoder reconnects for a keyframe at most this often. */
const VIDEO_RESYNC_MIN_INTERVAL_MS = 2_000;
/** Decoder failures in a row, with no picture between, before images. */
const VIDEO_FAILURES_BEFORE_IMAGES = 3;

const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SLOP_PX = 4;
/** A held-back touch press goes out once the finger has stayed down this long. */
export const TOUCH_PRESS_HOLD_MS = 150;
/** ...or moved this far (CSS px): it is a drag on the page, not a pinch. */
const TOUCH_PRESS_SLOP_PX = 8;
/** Two taps this close in time and place, while zoomed, return to fit. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 24;
/** How far a watcher's double tap zooms in. */
const DOUBLE_TAP_ZOOM = 2;

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

const INPUT_NOTICE_TEXT: Record<
  NonNullable<UseLiveSurfaceResult['inputNotice']>,
  string
> = {
  'control-changed':
    'Control changed before your input arrived, so it was not sent.',
  'input-failed': 'Your last input may not have reached the page. Check it.',
  'page-dialog': 'The page is showing a dialog. Answer it to continue.',
  'host-busy': 'The host is busy, so nothing was sent.',
};

/**
 * Why the person's last input did not take effect: one slim line over the
 * top of the surface they are looking at, the same banner for every case.
 * Input the host refused before sending any of it offers Retry while this
 * viewer may still send input (`canRetry`); input whose delivery is unknown
 * never does, since sending it again could apply it twice.
 */
function InputNotice(props: {
  surface: UseLiveSurfaceResult;
  canRetry: boolean;
  onRetry: () => void;
}) {
  const notice = props.surface.inputNotice;
  if (!notice) return null;
  const title = INPUT_NOTICE_TEXT[notice];
  if (notice === 'input-failed' || notice === 'host-busy')
    return (
      <ErrorState
        variant="compact"
        className="live-surface__input-notice"
        title={title}
        action={
          props.surface.retryableInput && props.canRetry ? (
            <Button
              size="sm"
              className="live-surface__input-notice-action"
              onClick={props.onRetry}
            >
              Retry
            </Button>
          ) : undefined
        }
      />
    );
  return (
    <div className="live-surface__input-notice" role="status">
      <Empty variant="compact" label={title} />
    </div>
  );
}

function controllerLine(
  surface: UseLiveSurfaceResult,
  touch = false,
): {
  text: string;
  tone: LiveSurfaceControllerTone;
} {
  const verb = touch ? 'Tap' : 'Click or type';
  const holder = surface.lease?.holder;
  if (!holder)
    return {
      text: `No one is in control. ${verb} to take control.`,
      tone: 'none',
    };
  if (holder.kind === 'agent')
    return {
      text: `An agent is in control. ${verb} to take control from it.`,
      tone: 'agent',
    };
  // Identity comes from the server (each viewer's state record names it),
  // never from which principal this client last saw win a claim.
  const self = surface.self;
  if (self && holder.principal === self.principal) {
    if (holder.device === self.device)
      return { text: 'You are in control.', tone: 'you' };
    return {
      text: `You are in control from another device. ${verb} here to take control.`,
      tone: 'other',
    };
  }
  return {
    text: `Another person is in control. ${verb} to take control.`,
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
  const [frameRotation, setFrameRotation] =
    useState<LiveSurfaceFrameRotation>(0);
  useEffect(() => {
    if (frameSize) props.onFrameSize?.(frameSize);
  }, [frameSize, props.onFrameSize]);
  const decodingRef = useRef(false);
  const drawnListenersRef = useRef(new Set<() => void>());
  const subscribeDrawn = useCallback((onDrawn: () => void) => {
    drawnListenersRef.current.add(onDrawn);
    return () => {
      drawnListenersRef.current.delete(onDrawn);
    };
  }, []);
  const nextFrameRef = useRef<LiveSurfaceFrame | null>(null);
  const composingRef = useRef(false);
  const lastDownRef = useRef<{
    at: number;
    x: number;
    y: number;
    count: number;
  } | null>(null);

  /**
   * Size the canvas for `header` and adopt it as the frame input maps to.
   * Every received frame does this, whether or not its picture decodes
   * here, so input and overlays follow the stream's geometry.
   */
  const adoptFrame = useCallback((header: LiveSurfaceFrameHeader) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    // A rotated frame is drawn turned, so the canvas has the SHOWN size
    // and input maps in the shown frame's pixels (see `toSurface`).
    const shown = shownSize(header);
    if (canvas.width !== shown.width) canvas.width = shown.width;
    if (canvas.height !== shown.height) canvas.height = shown.height;
    headerRef.current = header;
    canvas.dataset.surfaceWidth = String(shown.width);
    canvas.dataset.surfaceHeight = String(shown.height);
    canvas.dataset.surfaceScale = String(header.deviceScaleFactor);
    setFrameRotation(header.rotation ?? 0);
    setFrameSize((previous) =>
      previous?.width === shown.width && previous.height === shown.height
        ? previous
        : shown,
    );
    return canvas;
  }, []);

  /** Size the canvas for `header` and draw `picture` into it, turned. */
  const paint = useCallback(
    (picture: CanvasImageSource, header: LiveSurfaceFrameHeader) => {
      const canvas = adoptFrame(header);
      if (!canvas) return;
      const context = canvas.getContext('2d');
      if (!context) return;
      // An H.264 picture is decoded at the device's size and drawn at the
      // header's (the size input maps against), so draw to that box.
      if (!header.rotation) {
        context.drawImage(picture, 0, 0, header.width, header.height);
        for (const onDrawn of drawnListenersRef.current) onDrawn();
        return;
      }
      // Turn the drawing clockwise about the canvas origin, then shift it
      // back into the (already swapped) canvas box.
      context.save();
      if (header.rotation === 90) {
        context.translate(header.height, 0);
        context.rotate(Math.PI / 2);
      } else if (header.rotation === 180) {
        context.translate(header.width, header.height);
        context.rotate(Math.PI);
      } else {
        context.translate(0, header.width);
        context.rotate(-Math.PI / 2);
      }
      context.drawImage(picture, 0, 0, header.width, header.height);
      context.restore();
      for (const onDrawn of drawnListenersRef.current) onDrawn();
    },
    [adoptFrame],
  );

  const draw = useCallback(
    async (frame: LiveSurfaceFrame) => {
      // Latest-frame-wins in the client too: while one frame decodes, only
      // the newest waiting frame is kept.
      if (decodingRef.current) {
        nextFrameRef.current = frame;
        return;
      }
      decodingRef.current = true;
      let current: LiveSurfaceFrame | null = frame;
      while (current) {
        const { header, body } = current;
        adoptFrame(header);
        if (canvasRef.current && typeof createImageBitmap === 'function') {
          try {
            const bitmap = await createImageBitmap(
              new Blob([body.slice()], { type: `image/${header.codec}` }),
            );
            paint(bitmap, header);
            bitmap.close?.();
          } catch {
            // An undecodable frame is skipped; the next one replaces it.
          }
        }
        current = nextFrameRef.current;
        nextFrameRef.current = null;
      }
      decodingRef.current = false;
    },
    [adoptFrame, paint],
  );

  // H.264 (#4418): asked for only where WebCodecs can decode it. Every
  // access unit goes to the decoder in order (none may be skipped); the
  // decoder paints each picture it produces.
  const acceptH264 = useMemo(
    () => liveSurfaceH264Offered(props.apiBase),
    [props.apiBase],
  );
  /** Decoder failures since the last picture. */
  const videoFailuresRef = useRef(0);
  const videoDecoderRef = useRef<LiveSurfaceH264Decoder | null>(null);
  const lastResyncRef = useRef(Number.NEGATIVE_INFINITY);
  const resyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Ask for a keyframe by reconnecting (a fresh stream starts at one), at
   * most every two seconds; a request inside that window is deferred to its
   * end, because the reset decoder waits for nothing else.
   */
  const resyncVideo = useCallback(() => {
    if (resyncTimerRef.current) return;
    const wait =
      lastResyncRef.current + VIDEO_RESYNC_MIN_INTERVAL_MS - Date.now();
    resyncTimerRef.current = setTimeout(
      () => {
        resyncTimerRef.current = null;
        lastResyncRef.current = Date.now();
        surfaceRef.current.retry();
      },
      Math.max(0, wait),
    );
  }, []);
  const closeVideoDecoder = useCallback(() => {
    videoDecoderRef.current?.close();
    videoDecoderRef.current = null;
  }, []);
  const cancelResync = useCallback(() => {
    if (resyncTimerRef.current) clearTimeout(resyncTimerRef.current);
    resyncTimerRef.current = null;
  }, []);
  // A deferred resync belongs to the target it was asked for: a new target
  // (or unmount) cancels it rather than reconnecting a healthy stream.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the target props are the change keys.
  useEffect(
    () => () => {
      cancelResync();
      videoFailuresRef.current = 0;
    },
    [props.apiBase, props.surfaceId, props.projectSlug, cancelResync],
  );
  const decodeVideo = useCallback(
    async (frame: LiveSurfaceFrame) => {
      // Geometry first, as for images: overlays and input follow the
      // stream even before (or without) a decoded picture.
      adoptFrame(frame.header);
      let decoder = videoDecoderRef.current;
      if (!decoder) {
        decoder = new LiveSurfaceH264Decoder({
          onPicture: (picture, header) => {
            videoFailuresRef.current = 0;
            try {
              paint(picture, header);
            } finally {
              picture.close();
            }
          },
          onError: () => {
            videoFailuresRef.current += 1;
            if (videoFailuresRef.current < VIDEO_FAILURES_BEFORE_IMAGES) {
              resyncVideo();
              return;
            }
            // It keeps failing with nothing shown: stop asking for H.264.
            cancelResync();
            closeVideoDecoder();
            surfaceRef.current.declineH264();
          },
        });
        videoDecoderRef.current = decoder;
      }
      const outcome = await decoder.decode(frame.header, frame.body);
      if (outcome === 'unsupported' && videoDecoderRef.current === decoder) {
        closeVideoDecoder();
        cancelResync();
        surfaceRef.current.declineH264();
      }
    },
    [adoptFrame, paint, closeVideoDecoder, resyncVideo, cancelResync],
  );
  useEffect(() => closeVideoDecoder, [closeVideoDecoder]);

  const constrainedNetwork = useConstrainedNetwork();
  const pixels = useSteppedPixelBox(containerRef);
  const surface = useLiveSurface({
    apiBase: props.apiBase,
    surfaceId: props.surfaceId,
    params: liveSurfaceStreamBudget(props.params, {
      constrained: constrainedNetwork,
      pixels: pixels.box,
    }),
    paramsPending: !pixels.measured,
    visibilityRef: containerRef,
    onFrame: (frame) =>
      void (frame.header.codec === 'h264' ? decodeVideo(frame) : draw(frame)),
    transport: props.transport,
    now,
    acceptH264,
    acceptFold: props.acceptFold === true,
    ...(props.projectSlug ? { projectSlug: props.projectSlug } : {}),
    agentActionsEnabled: props.agentActionsEnabled === true,
  });
  const { onProducerStatus } = props;
  useEffect(() => {
    onProducerStatus?.(surface.producerStatus);
  }, [surface.producerStatus, onProducerStatus]);
  // A new target or a new stream starts a new decoder at its first keyframe.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the surface and its connection status are the change keys.
  useEffect(() => {
    if (surface.status !== 'live') closeVideoDecoder();
  }, [props.surfaceId, surface.status, closeVideoDecoder]);
  const { sendInput } = surface;
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;
  const inputChannel = surface.producerStatus.inputChannel;
  const inputReady =
    !props.readOnly &&
    surface.status === 'live' &&
    !surface.wedged &&
    (inputChannel === undefined || inputChannel === 'connected');
  const canInteract = inputReady && frameSize !== null && !props.readOnly;

  const holding = holdsControl(surface);
  /**
   * The host's lease-first rule, while it applies: not in immersive mode,
   * where the person chose to drive the surface (so a touch on it is input).
   */
  const requiresLeaseRef = useRef(props.inputRequiresLease === true);
  /** A claiming interaction may be sent: always, unless the host requires the lease first. */
  const mayClaim = () =>
    !requiresLeaseRef.current || holdsControl(surfaceRef.current);

  // Fit: the stage's size, measured, so the surface is the largest box at
  // the frame's aspect (a device screen is drawn exactly, never letterboxed).
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageBox, setStageBox] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const fitting = props.fit !== undefined;
  const projecting = fitting && props.projection !== undefined;
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if ((!fitting && !props.agentActionsEnabled) || !stage) return;
    const measure = () => {
      const rect = stage.getBoundingClientRect();
      setStageBox((previous) =>
        previous?.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [fitting, props.agentActionsEnabled]);
  let fitStyle: CSSProperties | undefined;
  if (props.fit && stageBox) {
    const aspect = frameSize
      ? (props.projection?.fitAspect?.(frameSize) ??
        frameSize.width / frameSize.height)
      : props.fit.aspect;
    const box = largestBoxAtAspect(stageBox, aspect);
    fitStyle = {
      width: `${box.width}px`,
      height: `${box.height}px`,
      ...(props.fit.cornerRadius
        ? { borderRadius: `${props.fit.cornerRadius(box)}px` }
        : {}),
    };
  }
  const actionBox =
    stageBox && frameSize
      ? largestBoxAtAspect(stageBox, frameSize.width / frameSize.height)
      : null;

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

  const projectionRef = useRef(props.projection);
  projectionRef.current = props.projection;
  const toSurface = useCallback(
    (clientX: number, clientY: number, clamp = false) => {
      const canvas = canvasRef.current;
      const header = headerRef.current;
      if (!canvas || !header) return null;
      const rect = canvas.getBoundingClientRect();
      const projection = projectionRef.current;
      if (projection) {
        const shown = shownSize(header);
        const point = projection.toFrame(
          { x: clientX, y: clientY },
          {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          },
          shown,
        );
        // A press must land on the drawn surface; a release or drag already
        // under way is kept at the edge it left by, as flat input is.
        if (!point) return clamp ? lastPointRef.current : null;
        return {
          x: point.x / header.deviceScaleFactor,
          y: point.y / header.deviceScaleFactor,
        };
      }
      return mapClientPointToSurface(
        { x: clientX, y: clientY },
        {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        },
        { ...shownSize(header), deviceScaleFactor: header.deviceScaleFactor },
        { clamp },
      );
    },
    [],
  );

  /** What a press needs once it goes out (a held-back touch press keeps it). */
  interface Press {
    pointerId: number;
    point: { x: number; y: number };
    clientX: number;
    clientY: number;
    button: number;
    pointerType: string;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }

  const sendPress = (press: Press) => {
    const { point } = press;
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
    heldPointerTypeRef.current = pointerTypeOf(press);
    const input: LiveSurfaceInput = {
      kind: 'pointer',
      type: 'down',
      ...point,
      clickCount: count,
      ...pointerTypeOf(press),
    };
    const button = buttonOf(press.button);
    if (button) {
      input.button = button;
      heldRef.current.add(button);
    }
    const modifiers = modifiersOf(press);
    if (modifiers) input.modifiers = modifiers;
    sendInput([input]);
  };

  // ---- touch: pinch zoom, and presses held back until they are not one ----
  const [zoom, setZoom] = useState<SurfaceZoom>(SURFACE_ZOOM_FIT);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  /** Touch pointers down on the canvas, in client pixels. */
  const touchesRef = useRef(new Map<number, ZoomPoint>());
  const pinchRef = useRef<{
    start: SurfaceZoom;
    from: [ZoomPoint, ZoomPoint];
    ids: [number, number];
  } | null>(null);
  /** Pointers that belong to a zoom gesture: nothing they do is input. */
  const zoomPointersRef = useRef(new Set<number>());
  const pendingPressRef = useRef<{
    press: Press;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const lastTouchDownRef = useRef<{ at: number; x: number; y: number } | null>(
    null,
  );
  /** A mouse drag panning the zoomed picture (never input). */
  const panRef = useRef<{
    pointerId: number;
    start: SurfaceZoom;
    x: number;
    y: number;
  } | null>(null);
  const sendPressRef = useRef(sendPress);
  sendPressRef.current = sendPress;

  /** Whether a press may go out NOW: eligibility can change while held. */
  const mayPressRef = useRef<() => boolean>(() => false);
  mayPressRef.current = () => canInteract && mayClaim();
  const flushPendingPress = () => {
    const pending = pendingPressRef.current;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingPressRef.current = null;
    if (!mayPressRef.current()) return;
    sendPressRef.current(pending.press);
  };
  const flushPendingPressRef = useRef(flushPendingPress);
  flushPendingPressRef.current = flushPendingPress;
  /** The held-back press is not going out (a pinch began): nothing was sent. */
  const dropPendingPress = () => {
    const pending = pendingPressRef.current;
    if (pending) clearTimeout(pending.timer);
    pendingPressRef.current = null;
  };
  useEffect(
    () => () => {
      const pending = pendingPressRef.current;
      if (pending) clearTimeout(pending.timer);
    },
    [],
  );

  /** A client point in the (untransformed) stage's own pixels. */
  const stageLocal = (point: ZoomPoint): ZoomPoint => {
    const rect = stageRef.current?.getBoundingClientRect();
    return rect ? { x: point.x - rect.left, y: point.y - rect.top } : point;
  };
  const stageExtent = () => {
    const rect = stageRef.current?.getBoundingClientRect();
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
  };

  const beginPinch = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    // Claimed here so a host (the float's drag) leaves it alone.
    event.preventDefault();
    // The press a first finger was holding back never goes out; one that
    // already did is released where it is (a press is never left down).
    dropPendingPress();
    if (heldRef.current.size > 0) releaseHeld();
    for (const id of touchesRef.current.keys()) zoomPointersRef.current.add(id);
    if (pinchRef.current) return; // a third finger joins nothing
    const [first, second] = [...touchesRef.current.entries()];
    if (!first || !second) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pinchRef.current = {
      start: zoomRef.current,
      from: [stageLocal(first[1]), stageLocal(second[1])],
      ids: [first[0], second[0]],
    };
  };

  /** A second quick tap, while zoomed: back to fit, and not input. */
  const isDoubleTap = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const at = now();
    const last = lastTouchDownRef.current;
    lastTouchDownRef.current = { at, x: event.clientX, y: event.clientY };
    return (
      !!last &&
      at - last.at <= DOUBLE_TAP_MS &&
      Math.hypot(event.clientX - last.x, event.clientY - last.y) <=
        DOUBLE_TAP_SLOP_PX
    );
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'touch') {
      // The first finger of a new gesture: no other finger is down, whatever
      // this canvas last heard (a finger a host captured, e.g. the float's
      // drag, never lifts here). Without this a stale finger joins the pinch.
      if (event.isPrimary) {
        touchesRef.current.clear();
        zoomPointersRef.current.clear();
        pinchRef.current = null;
      }
      touchesRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      if (touchesRef.current.size >= 2) {
        beginPinch(event);
        return;
      }
      if (isDoubleTap(event)) {
        // Zoomed: back to fit. At fit, and only while just watching (a
        // driver's double tap is the page's double click): in, at the tap.
        const watching = !canInteract || !mayClaim();
        if (zoomRef.current.scale > 1 || watching) {
          event.preventDefault();
          zoomPointersRef.current.add(event.pointerId);
          setZoom(
            zoomRef.current.scale > 1
              ? SURFACE_ZOOM_FIT
              : scaleSurfaceZoomAt(
                  zoomRef.current,
                  stageLocal({ x: event.clientX, y: event.clientY }),
                  DOUBLE_TAP_ZOOM,
                  stageExtent(),
                ),
          );
          return;
        }
      }
    }
    if (
      event.pointerType === 'mouse' &&
      event.button === 0 &&
      zoomRef.current.scale > 1 &&
      (!canInteract || !mayClaim())
    ) {
      // Zoomed and just watching: a mouse drag pans the picture.
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      panRef.current = {
        pointerId: event.pointerId,
        start: zoomRef.current,
        x: event.clientX,
        y: event.clientY,
      };
      return;
    }
    if (!canInteract || !mayClaim()) {
      // Not input: in immersive mode a tap on the picture shows the chrome.
      if (immersiveRef.current) revealChromeRef.current();
      return;
    }
    const point = toSurface(event.clientX, event.clientY);
    keyboardRef.current?.focus({ preventScroll: true });
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const press: Press = {
      pointerId: event.pointerId,
      point,
      clientX: event.clientX,
      clientY: event.clientY,
      button: event.button,
      pointerType: event.pointerType,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    };
    if (event.pointerType !== 'touch') {
      sendPress(press);
      return;
    }
    // Held back until it is a tap, a drag or a long press (see the header).
    dropPendingPress();
    pendingPressRef.current = {
      press,
      timer: setTimeout(
        () => flushPendingPressRef.current(),
        TOUCH_PRESS_HOLD_MS,
      ),
    };
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    touchesRef.current.delete(event.pointerId);
    if (panRef.current?.pointerId === event.pointerId) {
      panRef.current = null;
      return;
    }
    if (zoomPointersRef.current.has(event.pointerId)) {
      zoomPointersRef.current.delete(event.pointerId);
      if (pinchRef.current?.ids.includes(event.pointerId)) {
        pinchRef.current = null;
        setZoom((current) => settleSurfaceZoom(current));
      }
      return;
    }
    if (pendingPressRef.current?.press.pointerId === event.pointerId)
      flushPendingPress();
    if (!canInteract) return;
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

  const onPointerCancel = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    touchesRef.current.delete(event.pointerId);
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
    zoomPointersRef.current.delete(event.pointerId);
    if (pinchRef.current?.ids.includes(event.pointerId)) {
      pinchRef.current = null;
      setZoom((current) => settleSurfaceZoom(current));
    }
    // A cancelled press that was held back never went out.
    if (pendingPressRef.current?.press.pointerId === event.pointerId)
      dropPendingPress();
    releaseHeld();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (touchesRef.current.has(event.pointerId))
      touchesRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
    const pan = panRef.current;
    if (pan?.pointerId === event.pointerId) {
      setZoom(
        clampSurfaceZoom(
          {
            ...pan.start,
            x: pan.start.x + event.clientX - pan.x,
            y: pan.start.y + event.clientY - pan.y,
          },
          stageExtent(),
        ),
      );
      return;
    }
    const pinch = pinchRef.current;
    if (pinch?.ids.includes(event.pointerId)) {
      const [a, b] = pinch.ids.map((id) =>
        stageLocal(touchesRef.current.get(id) ?? { x: 0, y: 0 }),
      ) as [ZoomPoint, ZoomPoint];
      setZoom(pinchSurfaceZoom(pinch.start, pinch.from, [a, b], stageExtent()));
      return;
    }
    if (zoomPointersRef.current.has(event.pointerId)) return;
    const pending = pendingPressRef.current;
    if (pending?.press.pointerId === event.pointerId) {
      const travel = Math.hypot(
        event.clientX - pending.press.clientX,
        event.clientY - pending.press.clientY,
      );
      if (travel < TOUCH_PRESS_SLOP_PX) return;
      flushPendingPress();
    }
    if (!canInteract) return;
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
      // A trackpad pinch arrives as Ctrl+wheel: it zooms this view, and is
      // never input (the page does not see it).
      if (event.ctrlKey) {
        event.preventDefault();
        const rect = stageRef.current?.getBoundingClientRect();
        if (!rect) return;
        const unit = event.deltaMode === 1 ? 16 : 1;
        // Not settled per step: small trackpad steps must add up.
        setZoom((current) =>
          scaleSurfaceZoomAt(
            current,
            { x: event.clientX - rect.left, y: event.clientY - rect.top },
            Math.exp((-event.deltaY * unit) / 100),
            rect,
          ),
        );
        return;
      }
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
    // Safari reports a trackpad pinch as gesture events (a cumulative
    // `scale`), not Ctrl+wheel. Same meaning: this view zooms.
    let gestureStart: SurfaceZoom | null = null;
    const onGesture = (event: Event) => {
      const scale = (event as Event & { scale?: number }).scale;
      if (typeof scale !== 'number' || !Number.isFinite(scale)) return;
      event.preventDefault();
      if (event.type === 'gesturestart') gestureStart = zoomRef.current;
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect || !gestureStart) return;
      const at = event as Event & { clientX?: number; clientY?: number };
      const anchor = {
        x: (at.clientX ?? rect.left + rect.width / 2) - rect.left,
        y: (at.clientY ?? rect.top + rect.height / 2) - rect.top,
      };
      const next = scaleSurfaceZoomAt(gestureStart, anchor, scale, rect);
      setZoom(event.type === 'gestureend' ? settleSurfaceZoom(next) : next);
      if (event.type === 'gestureend') gestureStart = null;
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    for (const type of ['gesturestart', 'gesturechange', 'gestureend'])
      canvas.addEventListener(type, onGesture, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      for (const type of ['gesturestart', 'gesturechange', 'gestureend'])
        canvas.removeEventListener(type, onGesture);
    };
  }, [toSurface, sendInput]);

  const sendKey = (type: 'down' | 'up', event: ReactKeyboardEvent) => {
    if (
      !canInteract ||
      event.defaultPrevented ||
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

  const touchPointer = useCoarsePointer();
  const narrowViewport = useNarrowViewport();
  const controller = controllerLine(surface, touchPointer);
  const { onControlState } = props;
  const { status, claimControl, releaseControl, keepControlAlive } = surface;
  const tone = controller.tone;

  // ---- immersive: the same element over the whole viewport ----
  const {
    immersive,
    enter: enterImmersive,
    exit: exitImmersive,
  } = useImmersive(containerRef);
  const immersiveRef = useRef(immersive);
  immersiveRef.current = immersive;
  // Going full screen and back is this viewer still at the surface: a hold
  // it has is renewed (never claimed), so the bar does not open on
  // "No one is in control" merely because the viewer stopped touching.
  const wasImmersiveRef = useRef(immersive);
  const { onImmersiveChange } = props;
  useEffect(() => {
    if (wasImmersiveRef.current === immersive) return;
    wasImmersiveRef.current = immersive;
    if (holdsControl(surfaceRef.current)) void keepControlAlive();
    onImmersiveChange?.(immersive);
  }, [immersive, keepControlAlive, onImmersiveChange]);
  const requiresLease = props.inputRequiresLease === true && !immersive;
  requiresLeaseRef.current = requiresLease;
  // A touch press held back before eligibility changed (read-only, lost
  // input, immersive toggled, another surface) was meant for the old state:
  // it never goes out.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are the eligibility change keys.
  useEffect(() => {
    const pending = pendingPressRef.current;
    if (pending) clearTimeout(pending.timer);
    pendingPressRef.current = null;
  }, [canInteract, requiresLease, immersive, props.surfaceId]);
  /** Retry applies the rules any new input would meet right now. */
  const mayRetry = canInteract && (!requiresLease || holding);
  const inputNotice = (
    <InputNotice
      surface={surface}
      canRetry={mayRetry}
      onRetry={() => {
        if (!mayRetry) return;
        surface.retryInput();
        // Back to the page: on a phone, typing goes on where it stopped.
        keyboardRef.current?.focus({ preventScroll: true });
      }}
    />
  );
  const [chromeShown, setChromeShown] = useState(false);
  /** Any interaction with the chrome restarts its auto-hide. */
  const [chromeTouched, touchChrome] = useReducer((n: number) => n + 1, 0);
  /** A mouse over the bar, or keyboard focus in it, keeps it up. */
  const [chromeHeld, setChromeHeld] = useState(false);
  const revealChrome = () => {
    setChromeShown(true);
    touchChrome();
  };
  const revealChromeRef = useRef(revealChrome);
  revealChromeRef.current = revealChrome;
  // Entering shows the chrome (so Exit is in reach); leaving forgets it.
  useEffect(() => {
    setChromeShown(immersive);
    if (!immersive) setChromeHeld(false);
  }, [immersive]);
  useAutoHide(
    immersive && chromeShown && !chromeHeld,
    () => setChromeShown(false),
    CONTROLS_AUTO_HIDE_MS,
    chromeTouched,
  );
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const coarsePointer = useCoarsePointer();

  useEffect(() => {
    onControlState?.({
      status,
      tone,
      claimControl,
      releaseControl,
      keepControlAlive,
      immersive,
      enterImmersive,
      exitImmersive,
    });
  }, [
    onControlState,
    status,
    tone,
    claimControl,
    releaseControl,
    keepControlAlive,
    immersive,
    enterImmersive,
    exitImmersive,
  ]);
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
  else if (surface.status === 'queued')
    statusText =
      'Waiting: other live views are streaming. Hide one to show this.';
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

  // Video and input are separate channels: a device can keep streaming
  // while the socket that carries taps is down, and saying so is the
  // difference between "the device ignores me" and "wait a moment".
  // "The picture is still live" is said only when something shows it: a
  // real stream (not polled stills) that delivered a frame recently.
  const pictureLive =
    surface.producerStatus.videoMode !== 'snapshot-poll' &&
    frameAge !== null &&
    frameAge * 1000 < LIVE_SURFACE_STALL_MS;
  let inputLine: string | null = null;
  if (surface.status === 'live' && inputChannel === 'reconnecting')
    inputLine = pictureLive
      ? 'Input disconnected, reconnecting… The picture is still live.'
      : 'Input disconnected, reconnecting…';
  else if (surface.status === 'live' && inputChannel === 'down')
    inputLine =
      'Input is not reaching this surface. Controls are paused until it reconnects.';
  // Polled stills replace the IMAGE path only; an H.264 viewer still has video.
  const videoLine =
    surface.producerStatus.videoMode === 'snapshot-poll' &&
    surface.activeCodec !== 'h264'
      ? surface.producerStatus.videoDegradedReason === 'decoder-unavailable'
        ? 'Showing a screenshot each second. Install ffmpeg on the computer running Station for live video.'
        : 'Live video stopped. Showing a screenshot each second.'
      : null;

  return (
    <div
      className="live-surface"
      ref={containerRef}
      data-immersive={immersive ? '' : undefined}
      data-compact={immersive && narrowViewport ? '' : undefined}
      // Immersive owns Escape (it leaves full screen): the app's own Escape
      // shortcuts, such as "Go up one level", yield while it is active.
      data-escape-owner={immersive ? '' : undefined}
      // Diagnostics only (devtools, tests): what this viewer draws. Not
      // shown; a codec name is not something the person acts on.
      data-codec={
        surface.activeCodec && surface.status === 'live'
          ? surface.activeCodec
          : undefined
      }
      onPointerMove={
        immersive
          ? (event) => {
              if (event.pointerType === 'mouse') revealChrome();
            }
          : undefined
      }
    >
      {immersive
        ? null
        : props.renderHeader?.({ surface, inputReady, sendInput })}
      {/* With host controls the toolbar is left only for "Retry"; the
          immersive bar replaces it. */}
      {(props.hostControls || immersive) &&
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
            !props.readOnly &&
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
                Retry
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
      {inputLine ? (
        <p
          className="live-surface__notice live-surface__liveness"
          role="status"
          data-testid="live-surface-input-liveness"
        >
          {inputLine}
        </p>
      ) : null}
      {videoLine ? (
        <p className="live-surface__notice" role="status">
          {videoLine}
        </p>
      ) : null}
      <div
        className={`live-surface__stage${fitting ? ' live-surface__stage--fit' : ''}`}
        ref={stageRef}
        data-zoomed={zoom.scale > 1 ? '' : undefined}
      >
        {immersive && chromeShown ? null : inputNotice}
        {/* The zoom layer: the picture and what is drawn over the picture
            move and scale together; the stage around it does not. */}
        <div
          className="live-surface__zoom"
          data-testid="live-surface-zoom"
          style={
            zoom.scale === 1
              ? undefined
              : { transform: surfaceZoomTransform(zoom) }
          }
        >
          <canvas
            ref={canvasRef}
            style={fitStyle}
            className={`live-surface__canvas${fitting ? ' live-surface__canvas--fit' : ''}${projecting ? ' live-surface__canvas--projected' : ''}`}
            role="img"
            aria-label={`Live view of ${label}`}
            data-testid="live-surface-canvas"
            // Always listening: zoom is viewing, so it works without control;
            // each handler gates what it SENDS on `canInteract`.
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerMove={onPointerMove}
            onPointerCancel={onPointerCancel}
            onLostPointerCapture={releaseHeld}
            onContextMenu={(event) => event.preventDefault()}
          />
          {projecting && fitStyle && frameSize ? (
            <div
              aria-hidden="true"
              className="live-surface__overlay live-surface__projection"
              data-testid="live-surface-projection"
              style={fitStyle}
            >
              {props.projection!.render({
                canvas: canvasRef.current,
                shown: frameSize,
                subscribe: subscribeDrawn,
              })}
            </div>
          ) : null}
          {props.renderOverlay && fitStyle && frameSize ? (
            <div
              aria-hidden="true"
              className="live-surface__overlay"
              data-testid="live-surface-overlay"
              style={fitStyle}
            >
              {props.renderOverlay({
                shown: frameSize,
                rotation: frameRotation,
                visible: surface.status === 'live',
              })}
            </div>
          ) : null}
          {props.agentActionsEnabled && surface.agentAction && actionBox ? (
            <div
              className="live-surface__overlay"
              data-testid="agent-action-overlay"
              style={{
                width: `${actionBox.width}px`,
                height: `${actionBox.height}px`,
              }}
            >
              <AgentActionOverlay
                key={`${props.surfaceId}:${surface.agentAction.action.seq}`}
                action={surface.agentAction.action}
                expiresAt={surface.agentAction.expiresAt}
                now={now}
              />
            </div>
          ) : null}
        </div>
        <textarea
          ref={keyboardRef}
          data-live-surface-keyboard=""
          className="live-surface__keyboard"
          aria-label={`Keyboard input for ${label}`}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          readOnly={!canInteract || (requiresLease && !holding)}
          // Out of the tab order until this viewer may drive: tabbing through
          // a floated surface must not land keys on an agent's page.
          tabIndex={requiresLease && !holding ? -1 : undefined}
          onKeyDown={(event) => sendKey('down', event)}
          onKeyUp={(event) => sendKey('up', event)}
          onInput={onKeyboardInput}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={onCompositionEnd}
          onFocus={() => setKeyboardOpen(true)}
          onBlur={() => {
            setKeyboardOpen(false);
            releaseEverything();
          }}
        />
        {zoom.scale > 1 ? (
          <Button
            size="sm"
            variant="ghost"
            className="live-surface__zoom-reset"
            aria-label={`Zoom ${Math.round(zoom.scale * 100)}%. Reset to fit`}
            title="Reset zoom (or double-tap)"
            onClick={() => setZoom(SURFACE_ZOOM_FIT)}
          >
            {Math.round(zoom.scale * 100)}%
          </Button>
        ) : null}
        {props.overlay}
        {props.fullScreenButton && !immersive ? (
          <Button
            size="sm"
            variant="ghost"
            className="live-surface__fullscreen"
            data-pointer={coarsePointer ? 'coarse' : 'fine'}
            aria-label="Full screen"
            title="Full screen"
            onClick={enterImmersive}
          >
            <ExpandGlyph />
          </Button>
        ) : null}
        {statusText ? (
          <p className="live-surface__status" role="status">
            {statusText}
          </p>
        ) : null}
      </div>
      {immersive ? (
        chromeShown ? (
          // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only tracks whether a mouse or keyboard focus is holding the bar up; its buttons carry the semantics.
          <div
            className="live-surface__immersive-bar"
            onPointerEnter={(event) => {
              if (event.pointerType === 'mouse') setChromeHeld(true);
            }}
            onPointerLeave={() => setChromeHeld(false)}
            onPointerDown={touchChrome}
            onFocus={(event) => {
              if (isKeyboardFocus(event.target)) setChromeHeld(true);
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node))
                setChromeHeld(false);
            }}
          >
            <LiveSurfaceViewerControls
              label={`${label}: full screen controls`}
              status={DRIVER_TEXT[tone]}
              tone={tone}
              onClaim={
                !props.readOnly && tone !== 'you' && surface.status === 'live'
                  ? () => void claimControl()
                  : null
              }
              onRelease={tone === 'you' ? () => void releaseControl() : null}
              keyboard={
                holding && canInteract
                  ? {
                      open: keyboardOpen,
                      onToggle: () => {
                        touchChrome();
                        if (keyboardOpen) keyboardRef.current?.blur();
                        else
                          keyboardRef.current?.focus({ preventScroll: true });
                      },
                    }
                  : null
              }
              immersive
              onToggleImmersive={exitImmersive}
              trailing={props.renderImmersiveActions?.({
                surface,
                inputReady,
                sendInput,
              })}
              menu={props.renderImmersiveMenu?.({
                surface,
                inputReady,
                sendInput,
              })}
            />
            {inputNotice}
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="live-surface__immersive-reveal"
            aria-label="Show controls"
            title="Show controls"
            onClick={revealChrome}
          >
            <MoreGlyph />
          </Button>
        )
      ) : null}
    </div>
  );
}
