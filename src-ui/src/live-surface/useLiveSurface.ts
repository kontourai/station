import {
  PUBLIC_STATION_HANDSHAKE_PATH,
  parsePublicStationHandshake,
} from '@kontourai/station-contracts/environment-security';
import {
  LIVE_SURFACE_EPOCH_CAUSE_QUERY_KEY,
  LIVE_SURFACE_INPUT_MAX_BODY_BYTES,
  LIVE_SURFACE_INPUT_MAX_EVENTS,
  LIVE_SURFACE_TEXT_MAX_LENGTH,
  type LiveSurfaceAgentAction,
  type LiveSurfaceCodec,
  type LiveSurfaceControlLease,
  type LiveSurfaceEpochCause,
  type LiveSurfaceFrameHeader,
  type LiveSurfaceInput,
  type LiveSurfaceInputResult,
  type LiveSurfaceLeaseResult,
  type LiveSurfaceProducerStatus,
  LiveSurfaceRecordDecoder,
  type LiveSurfaceStreamParams,
  type LiveSurfaceViewerIdentity,
  parseLiveSurfaceControlLease,
  parseLiveSurfaceEpochCause,
} from '@kontourai/station-contracts/live-surface';
import { authenticatedFetch, hasCapability } from '@kontourai/station-sdk';
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useDocumentVisible } from '../lib/documentVisibility';
import {
  type LiveSurfaceStreamAdmission,
  liveSurfaceStreamAdmission,
} from './liveSurfaceStreamAdmission';

/**
 * Viewer side of a live surface (#90): one authenticated, length-prefixed
 * binary fetch stream per visible viewer, plus batched human input.
 *
 * This is a stream, not a query, so it is not React Query: there is no
 * cacheable response, only a connection whose lifetime follows visibility.
 * It goes through `authenticatedFetch` (the same auth boundary as every
 * protected stream; `EventSource` cannot carry the credential).
 *
 * - Suspends while hidden (document hidden, or the pane scrolled/collapsed
 *   out of view): the request is aborted, the server detaches the viewer,
 *   and a producer with no viewers stops. Nothing streams to a pane nobody
 *   can see — it would spend the ~6-per-origin connection budget (ADR 0018)
 *   and the relay's bandwidth for nothing.
 * - Admitted (#2760): a stream opens only with a slot from the per-origin
 *   frame-stream admission (`liveSurfaceStreamAdmission.ts`), so input and
 *   lease requests always have a connection. Past the cap the viewer reads
 *   `queued` until a slot frees; it holds no slot while it waits to
 *   reconnect.
 * - Reconnects with capped exponential backoff after a drop; a 404/403 is a
 *   typed terminal state, not something to hammer.
 * - Input is coalesced (consecutive moves collapse to the latest) and sent
 *   one POST at a time, each bounded to fit one relay chunk. A batch
 *   refused as `stale-epoch` or `stale-fence` (control changed hands before
 *   or during the batch) is DROPPED, not replayed: it was aimed at a view
 *   that changed hands, and replaying clicks onto a page someone else has
 *   since changed is exactly what the epoch exists to prevent. Anything this
 *   client held down when that happened was already released by the server
 *   at the handoff, so its eventual button/key UP is swallowed here: sending
 *   it would be fresh human input, and would take control straight back.
 * - Remote input goes through a hand-rolled single-flight queue, not React
 *   Query's `useMutation`: the queue coalesces moves, keeps one POST in
 *   flight, and drops everything on a stale refusal — state a per-request
 *   mutation does not own (N4).
 * - The epoch this client acts on only moves forward (it is the max of every
 *   epoch it has seen), so a frame published before a handoff can never
 *   walk it back behind a state record that already announced the handoff.
 * - Liveness counts BYTES, not records: a large frame still arriving over a
 *   slow relay is a live stream, not a stalled one.
 * - Codec (#4418): with `acceptH264` the stream asks for H.264 access units
 *   (`?codec=h264`). The frames' own `codec` says what arrived
 *   (`activeCodec`). A refusal of the codec (or of an unknown key by a host
 *   too old to name it), `declineH264` (the browser refused the profile or
 *   keeps failing), and a hub downgrade to images all stop this page asking
 *   for H.264 for that target (`liveSurfaceH264Declines`).
 */

export type LiveSurfaceConnectionStatus =
  | 'connecting'
  /** Waiting for a frame-stream slot on this origin (#2760). */
  | 'queued'
  | 'live'
  | 'reconnecting'
  | 'suspended'
  | 'unavailable'
  | 'denied';

/**
 * `host-busy` (#2433): the server could not authorize the input or claim
 * right now (503 `surface-busy`, e.g. a saturated SSH device host). Nothing
 * was sent; trying again may work. Not a refusal.
 */
export type LiveSurfaceInputNotice =
  | 'control-changed'
  | 'input-failed'
  | 'host-busy'
  /** The page is showing a dialog that waits for an answer. */
  | 'page-dialog'
  | null;

/** A retryable 503 `surface-busy` answer (#2433). */
function isSurfaceBusy(response: Response, envelope: unknown): boolean {
  return (
    response.status === 503 &&
    typeof envelope === 'object' &&
    envelope !== null &&
    (envelope as { code?: unknown }).code === 'surface-busy'
  );
}

export interface LiveSurfaceFrame {
  header: LiveSurfaceFrameHeader;
  body: Uint8Array;
  /** Client clock, so staleness never compares two different clocks. */
  receivedAt: number;
}

export interface UseLiveSurfaceOptions {
  apiBase: string;
  surfaceId: string;
  params?: Partial<LiveSurfaceStreamParams>;
  /** While true the stream waits, reading as connecting, for final `params`. */
  paramsPending?: boolean;
  /** Element whose on-screen visibility gates the stream. */
  visibilityRef: RefObject<Element | null>;
  onFrame: (frame: LiveSurfaceFrame) => void;
  /** Test seam; defaults to the SDK's `authenticatedFetch`. */
  transport?: typeof authenticatedFetch;
  /** Bound on each input or claim request (default 10 s); a test seam. */
  requestTimeoutMs?: number;
  now?: () => number;
  /**
   * Optional (Device pane lane, D12): the Project this surface is reached
   * from, sent as `?projectSlug=` on every request so the surface's
   * authorizer can admit that Project's admins to a device shared with it.
   */
  projectSlug?: string;
  agentActionsEnabled?: boolean;
  /** Ask for H.264 access units; the caller can decode them (#4418). */
  acceptH264?: boolean;
  /** Test seam; defaults to the page-wide frame-stream admission. */
  streamAdmission?: LiveSurfaceStreamAdmission;
}

export interface UseLiveSurfaceResult {
  status: LiveSurfaceConnectionStatus;
  lease: LiveSurfaceControlLease | null;
  effectiveParams: LiveSurfaceStreamParams | null;
  /** Client time the stream last delivered any bytes. */
  lastActivityAt: number | null;
  lastFrameAt: number | null;
  /** Who this viewer is, as the server told it (principal and device). */
  self: LiveSurfaceViewerIdentity | null;
  /** The server reports the surface is not taking input (see state.wedged). */
  wedged: boolean;
  /**
   * What the producer reported about its own channels (input liveness,
   * video mode, orientation); empty for a producer that reports nothing.
   */
  producerStatus: LiveSurfaceProducerStatus;
  inputNotice: LiveSurfaceInputNotice;
  agentAction: { action: LiveSurfaceAgentAction; expiresAt: number } | null;
  /** The codec of the last frame this viewer received, or null before one. */
  activeCodec: LiveSurfaceCodec | null;
  /** Stop asking for H.264 for this target and reconnect for images. */
  declineH264: () => void;
  /**
   * Queue input for the surface. Each event belongs to the control lineage
   * current when it was created (`options.lineage`, else now) and is sent
   * only while that lineage is still current: input never crosses a change
   * of control (see `controlLineage`).
   */
  sendInput: (
    events: LiveSurfaceInput[],
    options?: { lineage?: number },
  ) => void;
  /**
   * The current control lineage: it advances whenever control changes hands,
   * except this viewer's own takeover by its input. Read it when input is
   * created (e.g. a held-back press) and pass it to `sendInput`.
   */
  controlLineage: () => number;
  /**
   * Ask the host to release whatever this viewer has pressed (blur, a
   * hidden page, unmount). True when the host does that itself; false on a
   * host without it, where the caller sends its own releases.
   */
  releasePressed: () => boolean;
  /**
   * Input the host refused before dispatching any of it (`host-busy`), kept
   * at the control epoch it was meant for and sendable with `retryInput`.
   * Input whose delivery is unknown (`input-failed`) is never kept: sending
   * it again could apply it twice.
   */
  retryableInput: boolean;
  /**
   * Send the kept input again, ahead of anything newer. Does nothing when
   * control has changed hands since (the input was meant for that epoch).
   * The caller decides whether this viewer may send input right now.
   */
  retryInput: () => void;
  claimControl: () => Promise<void>;
  /**
   * Give control up explicitly (a hand-back): the server records the
   * release, and an agent may claim at once instead of waiting out this
   * person's hold. Only the holder's release is accepted.
   */
  releaseControl: () => Promise<void>;
  /**
   * Keep this person's current hold alive while they are shown something
   * that needs them (not input; the server caps it from their last input).
   */
  keepControlAlive: () => Promise<void>;
  /** Reconnect now; a fresh stream also starts H.264 at a keyframe. */
  retry: () => void;
}

/** How long "the host is busy" stays up without a newer outcome. */
const HOST_BUSY_NOTICE_MS = 5_000;

/**
 * Targets (`apiBase`, surface, Project context) this page has stopped asking
 * for H.264, for the rest of the page's session: the browser refused the
 * profile, the host refused the codec, or the hub switched a viewer to
 * images because it could not keep up. Remembering it keeps a reconnect, or
 * the pane reopening, from asking again and falling behind again.
 */
export const liveSurfaceH264Declines = new Set<string>();

const LIVE_SURFACE_RECONNECT_DELAYS_MS = [
  500, 1_000, 2_000, 4_000, 8_000, 10_000,
] as const;

function useIntersecting(ref: RefObject<Element | null>): boolean {
  const [intersecting, setIntersecting] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setIntersecting(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return intersecting;
}

/** `?projectSlug=` (or '') for a surface reached from a Project (D12). */
function contextQuery(projectSlug: string | undefined): string {
  return projectSlug
    ? `?${new URLSearchParams({ projectSlug }).toString()}`
    : '';
}

function streamUrl(
  apiBase: string,
  surfaceId: string,
  params: Partial<LiveSurfaceStreamParams> | undefined,
  projectSlug: string | undefined,
  agentActionsEnabled: boolean,
  h264: boolean,
  epochCause: boolean,
): string {
  const query = new URLSearchParams();
  for (const key of ['maxFps', 'quality', 'maxWidth', 'maxHeight'] as const) {
    const value = params?.[key];
    if (value !== undefined) query.set(key, String(Math.round(value)));
  }
  if (projectSlug) query.set('projectSlug', projectSlug);
  if (agentActionsEnabled) query.set('agentActions', '1');
  if (h264) query.set('codec', 'h264');
  if (epochCause) query.set(LIVE_SURFACE_EPOCH_CAUSE_QUERY_KEY, '1');
  const suffix = query.size > 0 ? `?${query}` : '';
  return `${apiBase}/api/live-surfaces/${encodeURIComponent(surfaceId)}/frames${suffix}`;
}

const encoder = new TextEncoder();

/** One capability answer per host and transport, shared by its viewers. */
const epochCauseCapabilities = new WeakMap<
  object,
  Map<string, Promise<boolean>>
>();

/**
 * Whether the host at `apiBase` advertises `liveSurfaceEpochCause`. Unknown
 * (unreachable, an older host) is false: the viewer then sends no request
 * ids and asks for no cause, which such a host would refuse.
 */
function epochCauseCapability(
  apiBase: string,
  transport: typeof authenticatedFetch,
): Promise<boolean> {
  let byHost = epochCauseCapabilities.get(transport);
  if (!byHost) {
    byHost = new Map();
    epochCauseCapabilities.set(transport, byHost);
  }
  const known = byHost.get(apiBase);
  if (known) return known;
  const asked = (async () => {
    try {
      const response = await transport(
        `${apiBase}${PUBLIC_STATION_HANDSHAKE_PATH}`,
        { method: 'GET' },
      );
      if (!response.ok) return false;
      const handshake = parsePublicStationHandshake(
        await response.json().catch(() => null),
      );
      return hasCapability(handshake, 'liveSurfaceEpochCause');
    } catch {
      return false;
    }
  })();
  byHost.set(apiBase, asked);
  // A failed read is asked again later rather than pinned.
  void asked.then((supported) => {
    if (!supported) setTimeout(() => byHost?.delete(apiBase), 30_000);
  });
  return asked;
}

/** Bound on one input, claim or lease request (#90 C). */
export const LIVE_SURFACE_REQUEST_TIMEOUT_MS = 10_000;

/** A fresh id for one of this viewer's own requests (contract shape). */
function newRequestId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

/** A queued release that may go in whichever lineage is current. */
const ANY_LINEAGE = -2;

/** How many of this viewer's own request ids it remembers. */
const OWN_REQUEST_IDS = 64;

/** A request was cut off: its deadline passed or its target went away. */
class LiveSurfaceRequestAborted extends Error {
  constructor() {
    super('live surface request aborted');
    this.name = 'LiveSurfaceRequestAborted';
  }
}

/**
 * Run `send` with a deadline and an abort signal, and settle when either
 * fires even if the transport ignores the signal: a hung request can never
 * hold the viewer's input or epoch.
 */
async function boundedRequest<T>(
  send: (signal: AbortSignal) => Promise<T>,
  target: AbortSignal,
  timeoutMs = LIVE_SURFACE_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let rejectAborted!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const abort = () => {
    controller.abort();
    rejectAborted(new LiveSurfaceRequestAborted());
  };
  const timer = setTimeout(abort, timeoutMs);
  if (target.aborted) abort();
  else target.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([send(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    target.removeEventListener('abort', abort);
  }
}

/** The held thing an event presses or releases, or null. */
function pressId(event: LiveSurfaceInput): string | null {
  if (
    event.kind === 'pointer' &&
    event.button &&
    (event.type === 'down' || event.type === 'up')
  )
    return `button:${event.button}`;
  if (event.kind === 'key') return `key:${event.code || event.key}`;
  return null;
}

function isRelease(event: LiveSurfaceInput): boolean {
  return (
    (event.kind === 'pointer' || event.kind === 'key') && event.type === 'up'
  );
}

/** Split over-long text so every event parses at the route. */
function normalizeEvents(events: LiveSurfaceInput[]): LiveSurfaceInput[] {
  const out: LiveSurfaceInput[] = [];
  for (const event of events) {
    if (event.kind !== 'text') {
      out.push(event);
      continue;
    }
    const chars = [...event.text];
    for (let i = 0; i < chars.length; i += LIVE_SURFACE_TEXT_MAX_LENGTH / 4) {
      out.push({
        kind: 'text',
        text: chars.slice(i, i + LIVE_SURFACE_TEXT_MAX_LENGTH / 4).join(''),
      });
    }
  }
  return out;
}

export function useLiveSurface(
  options: UseLiveSurfaceOptions,
): UseLiveSurfaceResult {
  const {
    apiBase,
    surfaceId,
    params,
    paramsPending = false,
    visibilityRef,
    transport = authenticatedFetch,
    now = Date.now,
    projectSlug,
    agentActionsEnabled = false,
    acceptH264 = false,
    streamAdmission = liveSurfaceStreamAdmission,
    requestTimeoutMs = LIVE_SURFACE_REQUEST_TIMEOUT_MS,
  } = options;
  const requestTimeoutRef = useRef(requestTimeoutMs);
  requestTimeoutRef.current = requestTimeoutMs;
  const onFrameRef = useRef(options.onFrame);
  onFrameRef.current = options.onFrame;
  const nowRef = useRef(now);
  nowRef.current = now;
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const admissionRef = useRef(streamAdmission);
  admissionRef.current = streamAdmission;

  const documentVisible = useDocumentVisible();
  const intersecting = useIntersecting(visibilityRef);
  const visible = documentVisible && intersecting;

  const [status, setStatus] = useState<LiveSurfaceConnectionStatus>(
    visible ? 'connecting' : 'suspended',
  );
  const [lease, setLease] = useState<LiveSurfaceControlLease | null>(null);
  const [effectiveParams, setEffectiveParams] =
    useState<LiveSurfaceStreamParams | null>(null);
  const [lastActivityAt, setLastActivityAt] = useState<number | null>(null);
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);
  const [self, setSelf] = useState<LiveSurfaceViewerIdentity | null>(null);
  const [wedged, setWedged] = useState(false);
  const [producerStatus, setProducerStatus] =
    useState<LiveSurfaceProducerStatus>({});
  const [inputNotice, setInputNotice] = useState<LiveSurfaceInputNotice>(null);
  const [agentAction, setAgentAction] = useState<{
    action: LiveSurfaceAgentAction;
    expiresAt: number;
  } | null>(null);
  const agentActionSequence = useRef(0);
  // Reset transient action state when the viewed surface or capability changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: both values define the reset boundary.
  useEffect(() => {
    agentActionSequence.current = 0;
    setAgentAction(null);
  }, [surfaceId, agentActionsEnabled]);
  const [retryToken, setRetryToken] = useState(0);
  const [activeCodec, setActiveCodec] = useState<LiveSurfaceCodec | null>(null);
  /** Bumped when a decline must reconnect at once (it re-runs the stream). */
  const [declineVersion, setDeclineVersion] = useState(0);
  const targetKey = `${apiBase}\n${surfaceId}\n${projectSlug ?? ''}`;
  /**
   * Record a decline. `reconnect` re-opens the stream now, for images; a
   * downgrade the hub already applied leaves the running stream alone, and
   * only the next connection asks for images.
   */
  const declineH264For = useCallback((key: string, reconnect = true) => {
    if (liveSurfaceH264Declines.has(key)) return;
    liveSurfaceH264Declines.add(key);
    if (reconnect) setDeclineVersion((version) => version + 1);
  }, []);
  const epochRef = useRef(0);
  const targetGenerationRef = useRef(0);
  /**
   * The control lineage every input item carries from the moment it is
   * created. The server's epoch also advances on this viewer's own takeover
   * by input (its queued input must still go, at the new epoch), so the
   * lineage, not the epoch, is what input is checked against: it advances on
   * every other change of control, and never on this device's own step to
   * the next epoch.
   */
  const lineageRef = useRef(0);
  const selfRef = useRef<LiveSurfaceViewerIdentity | null>(null);
  selfRef.current = self;
  const inFlightRef = useRef(false);
  /**
   * Each button/key this viewer pressed and has not released, with the
   * lineage it was pressed in. A release goes out only in that lineage: once
   * control changed hands (or the host released it), the host has released
   * the press, and sending its release would be fresh input that claims.
   */
  const pressedRef = useRef(new Map<string, number>());
  /** The host has released these presses itself (no lineage matches). */
  const RELEASED_BY_HOST = -1;
  /**
   * Whether the host says which request caused each epoch
   * (`liveSurfaceEpochCause`): null until known for this target.
   */
  const [epochCauseSupported, setEpochCauseSupported] = useState<
    boolean | null
  >(null);
  const epochCauseRef = useRef<boolean | null>(null);
  epochCauseRef.current = epochCauseSupported;
  /** This viewer's own recent request ids, newest last. */
  const ownRequestIdsRef = useRef<string[]>([]);
  const rememberRequestId = useCallback((id: string) => {
    const ids = ownRequestIdsRef.current;
    ids.push(id);
    if (ids.length > OWN_REQUEST_IDS) ids.shift();
  }, []);
  /** Aborted when this target's work must stop (target change, unmount). */
  const targetAbortRef = useRef(new AbortController());
  /** The newest lease the stream reported, with its cause, for reconcile. */
  const latestStreamLeaseRef = useRef<{
    lease: LiveSurfaceControlLease;
    cause: LiveSurfaceEpochCause | undefined;
  } | null>(null);

  /**
   * One gesture the host refused before dispatching any of it, kept whole
   * for `retryInput` in its lineage. `open` names its presses not yet
   * released: until they are, the gesture's moves (coalesced) and releases
   * join it instead of going out alone; any other input retires it whole.
   */
  const undeliveredRef = useRef<{
    events: LiveSurfaceInput[];
    lineage: number;
    open: Set<string>;
  } | null>(null);
  const [retryableInput, setRetryableInput] = useState(false);
  /** This viewer's own claim is awaiting its answer. */
  const claimInFlightRef = useRef(false);
  /**
   * A newer epoch was observed, and whether it is this viewer's own
   * takeover. Where the host says what caused each epoch, only that answer
   * decides: the epoch is this viewer's own exactly when its cause is one of
   * this viewer's request ids (another tab of the same person and device is
   * someone else). Where the host cannot say (an older Station), an answer
   * to this viewer's own input batch that took exactly the next epoch is its
   * own (the host hands control off only for that batch), and anything
   * reported while a request is in flight waits for that request's answer.
   * Anything else is a change of control: input from before it is retired.
   */
  const observeEpoch = useCallback(
    (
      epoch: number,
      evidence:
        | { from: 'answer'; cause?: LiveSurfaceEpochCause; handoff: boolean }
        | {
            from: 'stream';
            holder: LiveSurfaceControlLease['holder'];
            cause?: LiveSurfaceEpochCause;
          }
        | { from: 'frame' },
    ) => {
      if (epoch <= epochRef.current) return;
      const attested = epochCauseRef.current === true;
      const cause = evidence.from === 'frame' ? undefined : evidence.cause;
      let own = false;
      if (attested && cause !== undefined) {
        own =
          cause !== null && ownRequestIdsRef.current.includes(cause.requestId);
      } else if (attested) {
        // A frame alone: the state record, with its cause, follows it.
        if (evidence.from === 'frame') return;
      } else if (evidence.from === 'answer') {
        own = evidence.handoff;
      } else {
        const me = selfRef.current;
        const thisDevice =
          evidence.from === 'frame' ||
          (evidence.holder?.kind === 'human' &&
            !!me &&
            evidence.holder.principal === me.principal &&
            evidence.holder.device === me.device);
        // Reconciled when that request completes (see `reconcile`).
        if (thisDevice && (inFlightRef.current || claimInFlightRef.current))
          return;
      }
      epochRef.current = epoch;
      if (own) return;
      lineageRef.current += 1;
      undeliveredRef.current = null;
      setRetryableInput(false);
    },
    [],
  );
  const adoptLease = useCallback(
    (
      next: LiveSurfaceControlLease,
      evidence: Parameters<typeof observeEpoch>[1] = {
        from: 'answer',
        handoff: false,
      },
    ) => {
      observeEpoch(next.epoch, evidence);
      setLease(next);
    },
    [observeEpoch],
  );
  /** After any request completes: the newest lease the stream reported. */
  const reconcile = useCallback(() => {
    const latest = latestStreamLeaseRef.current;
    if (!latest) return;
    observeEpoch(latest.lease.epoch, {
      from: 'stream',
      holder: latest.lease.holder,
      cause: latest.cause,
    });
  }, [observeEpoch]);

  const paramsKey = JSON.stringify(params ?? {});

  // biome-ignore lint/correctness/useExhaustiveDependencies: paramsKey and retryToken are the change keys for params and retry.
  useEffect(() => {
    if (!visible) {
      setStatus('suspended');
      return;
    }
    // The caller is still settling what to ask for (the pane's size): open
    // once, with the final parameters, rather than twice. The same while
    // it is not yet known whether the host says what caused each epoch.
    if (paramsPending || epochCauseSupported === null) {
      setStatus('connecting');
      return;
    }
    const abort = new AbortController();
    const generation = targetGenerationRef.current;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    /** Each connection asks again whether H.264 is still wanted. */
    const askH264 = () => acceptH264 && !liveSurfaceH264Declines.has(targetKey);
    const urlFor = (h264: boolean) =>
      streamUrl(
        apiBase,
        surfaceId,
        params,
        projectSlug,
        agentActionsEnabled,
        h264,
        epochCauseSupported === true,
      );

    const scheduleReconnect = () => {
      if (stopped || generation !== targetGenerationRef.current) return;
      setStatus('reconnecting');
      const delay =
        LIVE_SURFACE_RECONNECT_DELAYS_MS[
          Math.min(attempt, LIVE_SURFACE_RECONNECT_DELAYS_MS.length - 1)
        ];
      attempt += 1;
      timer = setTimeout(() => {
        timer = null;
        void connect();
      }, delay);
    };

    let releaseSlot: (() => void) | null = null;
    const connect = async () => {
      const h264 = askH264();
      const url = urlFor(h264);
      const release = await admissionRef.current.admit(
        url,
        abort.signal,
        () => {
          if (!stopped) setStatus('queued');
        },
      );
      if (!release) return;
      if (stopped) {
        release();
        return;
      }
      setStatus((current) => (current === 'queued' ? 'connecting' : current));
      releaseSlot = release;
      try {
        await stream(url, h264);
      } finally {
        release();
        if (releaseSlot === release) releaseSlot = null;
      }
    };

    const stream = async (url: string, h264: boolean) => {
      let response: Response;
      try {
        response = await transportRef.current(url, {
          signal: abort.signal,
          timeoutMs: null,
          readOnly: true,
        });
      } catch {
        if (!abort.signal.aborted) scheduleReconnect();
        return;
      }
      if (stopped || generation !== targetGenerationRef.current) return;
      if (response.status === 400 && h264) {
        // A refusal of the codec itself declines H.264 for this target: the
        // host names the refused key (`field: 'codec'`). A host older than
        // `?codec=` refuses it as an unknown key but names nothing, so an
        // `invalid-request` naming no key is taken as that host too. A 400
        // naming any other key is not about the codec: it reconnects as
        // before. Never retry the refused request as it was.
        const envelope = (await response.json().catch(() => {
          void response.body?.cancel().catch(() => {});
          return null;
        })) as { code?: unknown; field?: unknown } | null;
        if (stopped || generation !== targetGenerationRef.current) return;
        if (
          envelope?.code === 'invalid-request' &&
          (envelope.field === 'codec' || envelope.field === undefined)
        )
          declineH264For(targetKey);
        else scheduleReconnect();
        return;
      }
      if (response.status === 404) {
        setStatus('unavailable');
        return;
      }
      if (response.status === 401 || response.status === 403) {
        setStatus('denied');
        return;
      }
      if (!response.ok || !response.body) {
        scheduleReconnect();
        return;
      }
      const reader = response.body.getReader();
      const decoder = new LiveSurfaceRecordDecoder();
      let receivedH264 = false;
      try {
        while (!stopped) {
          const chunk = await reader.read();
          if (stopped || generation !== targetGenerationRef.current) break;
          if (chunk.done) break;
          if (chunk.value.byteLength > 0) setLastActivityAt(nowRef.current());
          for (const record of decoder.push(chunk.value)) {
            const receivedAt = nowRef.current();
            attempt = 0;
            setStatus('live');
            if (record.kind === 'state') {
              const actions = record.state.agentActions;
              const latest = actions?.events.at(-1);
              if (
                agentActionsEnabled &&
                actions &&
                latest &&
                latest.seq > agentActionSequence.current
              ) {
                agentActionSequence.current = latest.seq;
                const age = Math.max(0, actions.now - latest.at);
                if (age < 700)
                  setAgentAction({
                    action: latest,
                    expiresAt: nowRef.current() + 700 - age,
                  });
              }
              // Who this viewer is decides whether a new epoch is its own
              // takeover, so it is known before the lease is adopted.
              if (record.state.viewer) selfRef.current = record.state.viewer;
              latestStreamLeaseRef.current = {
                lease: record.state.lease,
                cause: record.state.epochCause,
              };
              adoptLease(record.state.lease, {
                from: 'stream',
                holder: record.state.lease.holder,
                cause: record.state.epochCause,
              });
              setEffectiveParams(record.state.effectiveParams);
              setWedged(record.state.wedged === true);
              const {
                inputChannel,
                videoMode,
                videoDegradedReason,
                orientation,
                hostId,
              } = record.state;
              setProducerStatus((previous) =>
                previous.inputChannel === inputChannel &&
                previous.videoMode === videoMode &&
                previous.videoDegradedReason === videoDegradedReason &&
                previous.orientation === orientation &&
                previous.hostId === hostId
                  ? previous
                  : {
                      ...(inputChannel ? { inputChannel } : {}),
                      ...(videoMode ? { videoMode } : {}),
                      ...(videoDegradedReason ? { videoDegradedReason } : {}),
                      ...(orientation ? { orientation } : {}),
                      ...(hostId ? { hostId } : {}),
                    },
              );
              if (record.state.viewer) {
                const viewer = record.state.viewer;
                setSelf((previous) =>
                  previous?.principal === viewer.principal &&
                  previous.device === viewer.device
                    ? previous
                    : viewer,
                );
              }
            } else {
              observeEpoch(record.header.epoch, { from: 'frame' });
              setLastFrameAt(receivedAt);
              setActiveCodec(record.header.codec);
              // Images after H.264 on one stream: the hub switched this
              // viewer down. Remember it, so reconnects ask for images.
              if (record.header.codec === 'h264') receivedH264 = true;
              else if (receivedH264) declineH264For(targetKey, false);
              onFrameRef.current({
                header: record.header,
                body: record.body,
                receivedAt,
              });
            }
          }
        }
      } catch {
        // A decode error or a dropped connection: the length-prefixed stream
        // cannot resync, so start a fresh one.
      } finally {
        reader.cancel().catch(() => {});
      }
      if (!abort.signal.aborted) scheduleReconnect();
    };

    setStatus('connecting');
    void connect();
    return () => {
      stopped = true;
      abort.abort();
      releaseSlot?.();
      if (timer) clearTimeout(timer);
    };
  }, [
    apiBase,
    surfaceId,
    paramsKey,
    paramsPending,
    projectSlug,
    agentActionsEnabled,
    visible,
    retryToken,
    acceptH264,
    declineVersion,
    targetKey,
    declineH264For,
    adoptLease,
    observeEpoch,
    epochCauseSupported,
  ]);

  const declineH264 = useCallback(
    () => declineH264For(targetKey),
    [declineH264For, targetKey],
  );

  // ---- input -------------------------------------------------------------
  /** Queued input, each event with the lineage it was created in. */
  const queueRef = useRef<{ event: LiveSurfaceInput; lineage: number }[]>([]);
  const keepUndelivered = useCallback(
    (events: LiveSurfaceInput[], lineage = 0) => {
      if (events.length === 0) {
        undeliveredRef.current = null;
        setRetryableInput(false);
        return;
      }
      const open = new Set<string>();
      for (const event of events) {
        const id = pressId(event);
        if (!id) continue;
        if (isRelease(event)) open.delete(id);
        else open.add(id);
      }
      undeliveredRef.current = { events, lineage, open };
      setRetryableInput(true);
    },
    [],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: these values define the target whose queued work must be retired.
  useLayoutEffect(() => {
    targetGenerationRef.current += 1;
    queueRef.current = [];
    inFlightRef.current = false;
    claimInFlightRef.current = false;
    undeliveredRef.current = null;
    setRetryableInput(false);
    pressedRef.current.clear();
    ownRequestIdsRef.current = [];
    latestStreamLeaseRef.current = null;
    targetAbortRef.current.abort();
    targetAbortRef.current = new AbortController();
    epochRef.current = 0;
    lineageRef.current += 1;
    setLease(null);
    setSelf(null);
    setActiveCodec(null);
    return () => {
      targetGenerationRef.current += 1;
      queueRef.current = [];
      // Requests for this target stop; their answers are not waited for.
      targetAbortRef.current.abort();
    };
  }, [apiBase, surfaceId, projectSlug]);

  // Whether this host says what caused each epoch: asked once per host,
  // through the same transport, before the stream opens.
  useEffect(() => {
    let current = true;
    setEpochCauseSupported(null);
    void epochCauseCapability(apiBase, transportRef.current).then(
      (supported) => {
        if (current) setEpochCauseSupported(supported);
      },
    );
    return () => {
      current = false;
    };
  }, [apiBase]);
  const flushScheduledRef = useRef(false);
  const busyNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (busyNoticeTimerRef.current) clearTimeout(busyNoticeTimerRef.current);
    },
    [],
  );
  /** Say the host is busy; a successful send or 5 s later, stop saying it. */
  const showHostBusy = useCallback(() => {
    setInputNotice('host-busy');
    if (busyNoticeTimerRef.current) clearTimeout(busyNoticeTimerRef.current);
    busyNoticeTimerRef.current = setTimeout(() => {
      busyNoticeTimerRef.current = null;
      setInputNotice((current) => {
        if (current !== 'host-busy') return current;
        // The offer to send it again goes with the notice that made it.
        undeliveredRef.current = null;
        setRetryableInput(false);
        return null;
      });
    }, HOST_BUSY_NOTICE_MS);
  }, []);
  const inputUrl = `${apiBase}/api/live-surfaces/${encodeURIComponent(surfaceId)}/input${contextQuery(projectSlug)}`;
  const inputUrlRef = useRef(inputUrl);
  inputUrlRef.current = inputUrl;

  const flush = useCallback(async () => {
    flushScheduledRef.current = false;
    if (inFlightRef.current) return;
    // Checked immediately before dispatch: input created in a lineage that
    // has ended was meant for control that changed hands. It is dropped,
    // never sent at the newer epoch.
    const lineage = lineageRef.current;
    const current = (item: { lineage: number }) =>
      item.lineage === lineage || item.lineage === ANY_LINEAGE;
    const stale = queueRef.current.filter((item) => !current(item));
    if (stale.length > 0) {
      queueRef.current = queueRef.current.filter(current);
      setInputNotice('control-changed');
    }
    if (queueRef.current.length === 0) return;
    const batch: LiveSurfaceInput[] = [];
    let body = '';
    const batchEpoch = epochRef.current;
    // Only a host that says what caused each epoch takes a request id.
    const requestId = epochCauseRef.current === true ? newRequestId() : null;
    while (
      queueRef.current.length > 0 &&
      batch.length < LIVE_SURFACE_INPUT_MAX_EVENTS
    ) {
      const candidate = JSON.stringify({
        epoch: batchEpoch,
        events: [...batch, queueRef.current[0]!.event],
        ...(requestId ? { requestId } : {}),
      });
      if (
        encoder.encode(candidate).byteLength > LIVE_SURFACE_INPUT_MAX_BODY_BYTES
      )
        break;
      batch.push(queueRef.current.shift()!.event);
      body = candidate;
    }
    if (batch.length === 0) {
      // A single event that cannot fit is malformed; drop it rather than wedge.
      queueRef.current.shift();
      return;
    }
    inFlightRef.current = true;
    const generation = targetGenerationRef.current;
    if (requestId) rememberRequestId(requestId);
    try {
      const { response, envelope } = await boundedRequest(
        async (signal) => {
          const answer = await transportRef.current(inputUrlRef.current, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal,
          });
          return {
            response: answer,
            envelope: (await answer.json().catch(() => null)) as {
              data?: LiveSurfaceInputResult & { epochCause?: unknown };
            } | null,
          };
        },
        targetAbortRef.current.signal,
        requestTimeoutRef.current,
      );
      if (generation !== targetGenerationRef.current) return;
      // An answer for a lineage that has since ended describes control that
      // changed hands: nothing in it is kept, noticed or retried.
      if (lineage !== lineageRef.current) return;
      if (isSurfaceBusy(response, envelope)) {
        // Refused before any of it was dispatched, so sending it again
        // cannot apply anything twice. Not replayed on its own onto a view
        // that may have moved on: kept only for the person to send again.
        keepUndelivered(
          [...batch, ...queueRef.current.map((item) => item.event)],
          lineage,
        );
        queueRef.current = [];
        showHostBusy();
        return;
      }
      const result = envelope?.data;
      const nextLease = result
        ? parseLiveSurfaceControlLease(result.lease)
        : null;
      if (nextLease)
        adoptLease(nextLease, {
          from: 'answer',
          cause: parseLiveSurfaceEpochCause(result?.epochCause),
          // On a host that cannot say: only this batch, taking exactly the
          // next epoch, hands control off (the host refuses a stale epoch).
          handoff: result?.ok === true && nextLease.epoch === batchEpoch + 1,
        });
      if (result?.ok) {
        // A later success is not the kept input arriving: only Retry or the
        // person moving on retires that (see `sendInput`).
        setInputNotice((current) =>
          current === 'host-busy' && undeliveredRef.current ? current : null,
        );
      } else if (
        result &&
        !result.ok &&
        (result.code === 'stale-epoch' || result.code === 'stale-fence')
      ) {
        queueRef.current = [];
        keepUndelivered([]);
        setInputNotice('control-changed');
      } else if (result && !result.ok && result.code === 'page-dialog-open') {
        queueRef.current = [];
        keepUndelivered([]);
        setInputNotice('page-dialog');
      } else {
        // Indeterminate: the event that failed may have taken effect before
        // its error or timeout (`accepted` counts only completed ones), and
        // what follows it would land after a gap. Nothing is kept to send
        // again; the person checks the page.
        abandonIndeterminateRef.current();
      }
    } catch {
      if (generation !== targetGenerationRef.current) return;
      if (lineage !== lineageRef.current) return;
      // The answer was lost (or the request timed out): the batch may have
      // been applied.
      abandonIndeterminateRef.current();
    } finally {
      // Whatever happened to this batch's answer (used, discarded as
      // describing ended control, lost or timed out): reconcile to the
      // newest lease the stream reported, then send what is queued behind
      // it in the current lineage.
      if (generation === targetGenerationRef.current) {
        inFlightRef.current = false;
        reconcile();
        if (queueRef.current.length > 0) scheduleFlushRef.current();
      }
    }
  }, [adoptLease, showHostBusy, keepUndelivered, reconcile, rememberRequestId]);
  /**
   * After a batch whose effect is unknown: nothing is sent again, and what
   * this viewer may have pressed is released. A host that releases presses
   * itself is asked to; on an older host the releases already queued still
   * go, so a press that did land is not left down.
   */
  const abandonIndeterminateRef = useRef(() => {});
  abandonIndeterminateRef.current = () => {
    keepUndelivered([]);
    if (releasePressedRef.current()) queueRef.current = [];
    // An older host: the releases already queued go in whatever lineage
    // the stream settles on. A change to anyone else would already have
    // ended this lineage (and this answer would not be handled here), so
    // what can still follow is this device's own controller, whose
    // release the host accepts and needs.
    else
      queueRef.current = queueRef.current
        .filter((item) => isRelease(item.event))
        .map((item) => ({ ...item, lineage: ANY_LINEAGE }));
    setInputNotice('input-failed');
  };
  const releasePressedRef = useRef<() => boolean>(() => false);
  const scheduleFlushRef = useRef(() => {});
  scheduleFlushRef.current = () => {
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;
    queueMicrotask(() => void flush());
  };

  const sendInput = useCallback(
    (events: LiveSurfaceInput[], options?: { lineage?: number }) => {
      const lineage = options?.lineage ?? lineageRef.current;
      for (const event of normalizeEvents(events)) {
        const id = pressId(event);
        // Created before control changed hands (a held-back press): never
        // sent. It never becomes a press of this viewer, so a newer press of
        // the same button keeps its own release.
        if (lineage !== lineageRef.current) continue;
        const kept = undeliveredRef.current;
        if (kept) {
          const continuesGesture =
            kept.open.size > 0 &&
            ((event.kind === 'pointer' && event.type === 'move') ||
              (id !== null && isRelease(event) && kept.open.has(id)));
          if (continuesGesture) {
            // The moves (coalesced, so a long drag has no count cliff) and
            // release of a press that is kept join it: Retry sends the whole
            // gesture, and its release never goes out alone.
            const last = kept.events[kept.events.length - 1];
            if (
              event.kind === 'pointer' &&
              event.type === 'move' &&
              last?.kind === 'pointer' &&
              last.type === 'move'
            )
              kept.events[kept.events.length - 1] = event;
            else kept.events.push(event);
            if (id) {
              kept.open.delete(id);
              pressedRef.current.delete(id);
            }
            continue;
          }
          // New input (a new press, a key, text): the person moved on, so
          // the kept input is retired rather than sent after it.
          undeliveredRef.current = null;
          setRetryableInput(false);
          setInputNotice((current) =>
            current === 'host-busy' ? null : current,
          );
        }
        if (id && isRelease(event)) {
          const pressedIn = pressedRef.current.get(id);
          pressedRef.current.delete(id);
          // The press belongs to control that has since changed hands (or
          // the host released it itself): the host released it, so this
          // release would be fresh input that claims. It is not sent.
          if (pressedIn !== undefined && pressedIn !== lineage) continue;
        } else if (id) {
          // A fresh press (including a held key's auto-repeat), in this lineage.
          pressedRef.current.set(id, lineage);
        }
        const queue = queueRef.current;
        const last = queue[queue.length - 1]?.event;
        if (
          event.kind === 'pointer' &&
          event.type === 'move' &&
          last?.kind === 'pointer' &&
          last.type === 'move'
        ) {
          queue[queue.length - 1] = { event, lineage };
        } else {
          queue.push({ event, lineage });
        }
      }
      if (!flushScheduledRef.current) {
        flushScheduledRef.current = true;
        queueMicrotask(() => void flush());
      }
    },
    [flush],
  );

  const controlLineage = useCallback(() => lineageRef.current, []);

  /**
   * Ask the host to release whatever this viewer has pressed, fenced by the
   * epoch it holds. False on a host without that (the caller then sends its
   * own releases). Its releases are then not sent: the host did it.
   */
  const releasePressed = useCallback(() => {
    if (epochCauseRef.current !== true) return false;
    for (const id of pressedRef.current.keys())
      pressedRef.current.set(id, RELEASED_BY_HOST);
    void boundedRequest(
      (signal) =>
        transportRef.current(
          `${apiBase}/api/live-surfaces/${encodeURIComponent(surfaceId)}/lease${contextQuery(projectSlug)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'release-pressed',
              epoch: epochRef.current,
            }),
            signal,
            keepalive: true,
          },
        ),
      // Not tied to the target: an unmount sends it on the way out.
      new AbortController().signal,
    ).catch(() => {
      // The host also releases when this viewer's stream closes.
    });
    return true;
  }, [apiBase, surfaceId, projectSlug]);
  releasePressedRef.current = releasePressed;

  const retryInput = useCallback(() => {
    const kept = undeliveredRef.current;
    keepUndelivered([]);
    if (!kept) return;
    setInputNotice(null);
    // Meant for control that has since changed hands.
    if (kept.lineage !== lineageRef.current) return;
    // Ahead of anything typed since, still in its own lineage: the flush
    // checks it again immediately before dispatch.
    queueRef.current = [
      ...kept.events.map((event) => ({ event, lineage: kept.lineage })),
      ...queueRef.current,
    ];
    if (!flushScheduledRef.current) {
      flushScheduledRef.current = true;
      queueMicrotask(() => void flush());
    }
  }, [flush, keepUndelivered]);

  const claimControl = useCallback(async () => {
    const generation = targetGenerationRef.current;
    claimInFlightRef.current = true;
    const requestId = epochCauseRef.current === true ? newRequestId() : null;
    if (requestId) rememberRequestId(requestId);
    try {
      const { response, envelope } = await boundedRequest(
        async (signal) => {
          const answer = await transportRef.current(
            `${apiBase}/api/live-surfaces/${encodeURIComponent(surfaceId)}/lease${contextQuery(projectSlug)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'claim',
                ...(requestId ? { requestId } : {}),
              }),
              signal,
            },
          );
          return {
            response: answer,
            envelope: (await answer.json().catch(() => null)) as {
              data?: LiveSurfaceLeaseResult & { epochCause?: unknown };
            } | null,
          };
        },
        targetAbortRef.current.signal,
        requestTimeoutRef.current,
      );
      if (generation !== targetGenerationRef.current) return;
      if (isSurfaceBusy(response, envelope)) {
        showHostBusy();
        return;
      }
      const nextLease = envelope?.data
        ? parseLiveSurfaceControlLease(envelope.data.lease)
        : null;
      if (!nextLease) return;
      // A claim never proves a takeover by itself (it may only renew control
      // another tab of this device took): only its attested cause does.
      adoptLease(nextLease, {
        from: 'answer',
        cause: parseLiveSurfaceEpochCause(envelope?.data?.epochCause),
        handoff: false,
      });
    } catch {
      if (generation === targetGenerationRef.current)
        setInputNotice('input-failed');
    } finally {
      if (generation === targetGenerationRef.current) {
        claimInFlightRef.current = false;
        reconcile();
      }
    }
  }, [
    apiBase,
    surfaceId,
    projectSlug,
    adoptLease,
    showHostBusy,
    reconcile,
    rememberRequestId,
  ]);

  const leaseRef = useRef(lease);
  leaseRef.current = lease;
  const releaseControl = useCallback(async () => {
    const current = leaseRef.current;
    if (!current) return;
    const generation = targetGenerationRef.current;
    try {
      const response = await transportRef.current(
        `${apiBase}/api/live-surfaces/${encodeURIComponent(surfaceId)}/lease${contextQuery(projectSlug)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'release', epoch: current.epoch }),
        },
      );
      const envelope = (await response.json().catch(() => null)) as {
        data?: LiveSurfaceLeaseResult;
      } | null;
      if (generation !== targetGenerationRef.current) return;
      if (isSurfaceBusy(response, envelope)) {
        showHostBusy();
        return;
      }
      const nextLease = envelope?.data
        ? parseLiveSurfaceControlLease(envelope.data.lease)
        : null;
      if (nextLease) adoptLease(nextLease);
    } catch {
      if (generation === targetGenerationRef.current)
        setInputNotice('input-failed');
    }
  }, [apiBase, surfaceId, projectSlug, adoptLease, showHostBusy]);

  const keepControlAlive = useCallback(async () => {
    const current = leaseRef.current;
    if (!current) return;
    const generation = targetGenerationRef.current;
    try {
      const response = await transportRef.current(
        `${apiBase}/api/live-surfaces/${encodeURIComponent(surfaceId)}/lease${contextQuery(projectSlug)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'keep-alive', epoch: current.epoch }),
        },
      );
      const envelope = (await response.json().catch(() => null)) as {
        data?: LiveSurfaceLeaseResult;
      } | null;
      if (generation !== targetGenerationRef.current) return;
      const nextLease = envelope?.data
        ? parseLiveSurfaceControlLease(envelope.data.lease)
        : null;
      if (nextLease) adoptLease(nextLease);
    } catch {
      // A missed keep-alive only lets the hold lapse as it would anyway.
    }
  }, [apiBase, surfaceId, projectSlug, adoptLease]);

  const retry = useCallback(() => setRetryToken((value) => value + 1), []);

  return {
    status,
    lease,
    effectiveParams,
    lastActivityAt,
    lastFrameAt,
    self,
    wedged,
    producerStatus,
    inputNotice,
    agentAction,
    activeCodec,
    declineH264,
    sendInput,
    controlLineage,
    releasePressed,
    retryableInput,
    retryInput,
    claimControl,
    releaseControl,
    keepControlAlive,
    retry,
  };
}
