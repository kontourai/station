import {
  LIVE_SURFACE_INPUT_MAX_BODY_BYTES,
  LIVE_SURFACE_INPUT_MAX_EVENTS,
  LIVE_SURFACE_TEXT_MAX_LENGTH,
  type LiveSurfaceAgentAction,
  type LiveSurfaceCodec,
  type LiveSurfaceControlLease,
  type LiveSurfaceFrameHeader,
  type LiveSurfaceInput,
  type LiveSurfaceInputResult,
  type LiveSurfaceLeaseResult,
  type LiveSurfaceProducerStatus,
  LiveSurfaceRecordDecoder,
  type LiveSurfaceStreamParams,
  type LiveSurfaceViewerIdentity,
  parseLiveSurfaceControlLease,
} from '@kontourai/station-contracts/live-surface';
import { authenticatedFetch } from '@kontourai/station-sdk';
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
  /**
   * Ask for a foldable's `fold` state and display-tagged frames
   * (`?fold=1`). A host that does not offer them, or a viewer that does not
   * ask, gets the records an earlier client can read.
   */
  acceptFold?: boolean;
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
  sendInput: (events: LiveSurfaceInput[]) => void;
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

/**
 * Targets whose host refused `?fold=1` (a host older than the key): asked
 * again without it, for the rest of the page's session.
 */
export const liveSurfaceFoldDeclines = new Set<string>();

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
  fold = false,
): string {
  const query = new URLSearchParams();
  for (const key of ['maxFps', 'quality', 'maxWidth', 'maxHeight'] as const) {
    const value = params?.[key];
    if (value !== undefined) query.set(key, String(Math.round(value)));
  }
  if (projectSlug) query.set('projectSlug', projectSlug);
  if (agentActionsEnabled) query.set('agentActions', '1');
  if (h264) query.set('codec', 'h264');
  if (fold) query.set('fold', '1');
  const suffix = query.size > 0 ? `?${query}` : '';
  return `${apiBase}/api/live-surfaces/${encodeURIComponent(surfaceId)}/frames${suffix}`;
}

const encoder = new TextEncoder();

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
    acceptFold = false,
    streamAdmission = liveSurfaceStreamAdmission,
  } = options;
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
  // The decline sets are page-wide, but the reconnect they trigger is this
  // hook's own: every hook that was refused must reconnect, including one
  // whose target another viewer already recorded as declined.
  const declineH264For = useCallback((key: string, reconnect = true) => {
    liveSurfaceH264Declines.add(key);
    if (reconnect) setDeclineVersion((version) => version + 1);
  }, []);
  const declineFoldFor = useCallback((key: string) => {
    liveSurfaceFoldDeclines.add(key);
    setDeclineVersion((version) => version + 1);
  }, []);
  const epochRef = useRef(0);
  const targetGenerationRef = useRef(0);

  /**
   * Input the host refused before dispatching any of it, kept for
   * `retryInput` with the control epoch it was sent at. `open` names the
   * presses in it not yet released: until they are, the rest of that
   * gesture (its moves and its release) joins it instead of going out alone,
   * so a later no-op release never stands in for the press it belongs to.
   */
  const undeliveredRef = useRef<{
    events: LiveSurfaceInput[];
    epoch: number;
    open: Set<string>;
  } | null>(null);
  const [retryableInput, setRetryableInput] = useState(false);
  const observeEpoch = useCallback((epoch: number) => {
    epochRef.current = Math.max(epochRef.current, epoch);
    // Control changed hands: kept input was meant for the old epoch.
    const kept = undeliveredRef.current;
    if (kept && kept.epoch !== epochRef.current) {
      undeliveredRef.current = null;
      setRetryableInput(false);
    }
  }, []);
  const adoptLease = useCallback(
    (next: LiveSurfaceControlLease) => {
      observeEpoch(next.epoch);
      setLease(next);
    },
    [observeEpoch],
  );

  const paramsKey = JSON.stringify(params ?? {});

  // biome-ignore lint/correctness/useExhaustiveDependencies: paramsKey and retryToken are the change keys for params and retry.
  useEffect(() => {
    if (!visible) {
      setStatus('suspended');
      return;
    }
    // The caller is still settling what to ask for (the pane's size): open
    // once, with the final parameters, rather than twice.
    if (paramsPending) {
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
    const askFold = () => acceptFold && !liveSurfaceFoldDeclines.has(targetKey);
    const urlFor = (h264: boolean, fold: boolean) =>
      streamUrl(
        apiBase,
        surfaceId,
        params,
        projectSlug,
        agentActionsEnabled,
        h264,
        fold,
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
      const fold = askFold();
      const url = urlFor(h264, fold);
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
        await stream(url, h264, fold);
      } finally {
        release();
        if (releaseSlot === release) releaseSlot = null;
      }
    };

    const stream = async (url: string, h264: boolean, fold: boolean) => {
      let response: Response;
      try {
        response = await transport(url, {
          signal: abort.signal,
          timeoutMs: null,
          readOnly: true,
        });
      } catch {
        if (!abort.signal.aborted) scheduleReconnect();
        return;
      }
      if (stopped || generation !== targetGenerationRef.current) return;
      if (response.status === 400 && (h264 || fold)) {
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
        // `?fold=1` the same way: a host older than it names `unknown` (or,
        // older still, nothing); either way ask again without it.
        const refused =
          envelope?.code === 'invalid-request' ? envelope.field : null;
        const declineCodec =
          h264 && (refused === 'codec' || refused === undefined);
        const declineFold =
          fold &&
          (refused === 'fold' ||
            refused === 'unknown' ||
            refused === undefined);
        if (declineFold) declineFoldFor(targetKey);
        if (declineCodec) declineH264For(targetKey);
        if (!declineFold && !declineCodec) scheduleReconnect();
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
              adoptLease(record.state.lease);
              setEffectiveParams(record.state.effectiveParams);
              setWedged(record.state.wedged === true);
              const {
                inputChannel,
                videoMode,
                videoDegradedReason,
                orientation,
                fold,
                hostId,
              } = record.state;
              setProducerStatus((previous) =>
                previous.inputChannel === inputChannel &&
                previous.videoMode === videoMode &&
                previous.videoDegradedReason === videoDegradedReason &&
                previous.orientation === orientation &&
                // A heartbeat re-sends the same fold as a new object.
                JSON.stringify(previous.fold) === JSON.stringify(fold) &&
                previous.hostId === hostId
                  ? previous
                  : {
                      ...(inputChannel ? { inputChannel } : {}),
                      ...(videoMode ? { videoMode } : {}),
                      ...(videoDegradedReason ? { videoDegradedReason } : {}),
                      ...(orientation ? { orientation } : {}),
                      ...(fold ? { fold } : {}),
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
              observeEpoch(record.header.epoch);
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
    acceptFold,
    declineVersion,
    targetKey,
    declineH264For,
    declineFoldFor,
    adoptLease,
    observeEpoch,
    transport,
  ]);

  const declineH264 = useCallback(
    () => declineH264For(targetKey),
    [declineH264For, targetKey],
  );

  // ---- input -------------------------------------------------------------
  const queueRef = useRef<LiveSurfaceInput[]>([]);
  /** Buttons/keys this client pressed and has not released. */
  const pressedRef = useRef(new Set<string>());
  /** Pressed when control changed hands; the server released them already. */
  const orphanedRef = useRef(new Set<string>());
  const inFlightRef = useRef(false);
  const keepUndelivered = useCallback(
    (events: LiveSurfaceInput[], epoch = 0) => {
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
      undeliveredRef.current = { events, epoch, open };
      setRetryableInput(true);
    },
    [],
  );
  const discardRefusedInput = useCallback(
    (notice: LiveSurfaceInputNotice) => {
      queueRef.current = [];
      keepUndelivered([]);
      for (const id of pressedRef.current) orphanedRef.current.add(id);
      pressedRef.current.clear();
      setInputNotice(notice);
    },
    [keepUndelivered],
  );
  const sourceRef = useRef<{
    open: Promise<string | null> | null;
    retired: boolean;
    transport: typeof transport;
    leaseUrl: string;
    inputUrl: string;
  } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: these values define the target whose queued work must be retired.
  useLayoutEffect(() => {
    targetGenerationRef.current += 1;
    const source = {
      open: null as Promise<string | null> | null,
      retired: false,
      transport: transportRef.current,
      leaseUrl: `${apiBase}/api/live-surfaces/${encodeURIComponent(surfaceId)}/lease${contextQuery(projectSlug)}`,
      inputUrl: `${apiBase}/api/live-surfaces/${encodeURIComponent(surfaceId)}/input${contextQuery(projectSlug)}`,
    };
    sourceRef.current = source;
    queueRef.current = [];
    inFlightRef.current = false;
    undeliveredRef.current = null;
    setRetryableInput(false);
    pressedRef.current.clear();
    orphanedRef.current.clear();
    epochRef.current = 0;
    setLease(null);
    setSelf(null);
    setActiveCodec(null);
    return () => {
      source.retired = true;
      targetGenerationRef.current += 1;
      queueRef.current = [];
      if (source.open)
        void source.open.then((sourceId) => {
          if (sourceId)
            return source
              .transport(source.leaseUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: 'close-input-source',
                  sourceId,
                }),
              })
              .catch(() => {});
        });
    };
  }, [apiBase, surfaceId, projectSlug, transport]);
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

  const flush = useCallback(async () => {
    flushScheduledRef.current = false;
    if (inFlightRef.current || queueRef.current.length === 0) return;
    const batch: LiveSurfaceInput[] = [];
    let body = '';
    while (
      queueRef.current.length > 0 &&
      batch.length < LIVE_SURFACE_INPUT_MAX_EVENTS
    ) {
      const candidate = JSON.stringify({
        epoch: epochRef.current,
        sourceId: '00000000-0000-0000-0000-000000000000',
        events: [...batch, queueRef.current[0]],
      });
      if (
        encoder.encode(candidate).byteLength > LIVE_SURFACE_INPUT_MAX_BODY_BYTES
      )
        break;
      batch.push(queueRef.current.shift()!);
      body = candidate;
    }
    if (batch.length === 0) {
      // A single event that cannot fit is malformed; drop it rather than wedge.
      queueRef.current.shift();
      return;
    }
    inFlightRef.current = true;
    const generation = targetGenerationRef.current;
    const batchEpoch = epochRef.current;
    const source = sourceRef.current;
    try {
      if (!source || source.retired) return;
      source.open ??= source
        .transport(source.leaseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'open-input-source' }),
        })
        .then(async (response) => {
          if (!response.ok) return null;
          const envelope = await response.json();
          const id = envelope?.data?.sourceId;
          return typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)
            ? id
            : null;
        })
        .catch(() => null);
      const sourceId = await source.open;
      if (
        !sourceId ||
        source.retired ||
        generation !== targetGenerationRef.current
      ) {
        if (generation === targetGenerationRef.current) {
          source.open = null;
          discardRefusedInput('input-failed');
        }
        return;
      }
      body = JSON.stringify({ ...JSON.parse(body), sourceId });
      const response = await source.transport(source.inputUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const envelope = (await response.json().catch(() => null)) as {
        data?: LiveSurfaceInputResult;
      } | null;
      if (generation !== targetGenerationRef.current) return;
      if (isSurfaceBusy(response, envelope)) {
        // Refused before any of it was dispatched, so sending it again
        // cannot apply anything twice. Not replayed on its own onto a view
        // that may have moved on: kept only for the person to send again.
        keepUndelivered([...batch, ...queueRef.current], batchEpoch);
        queueRef.current = [];
        showHostBusy();
        return;
      }
      const result = envelope?.data;
      const nextLease = result
        ? parseLiveSurfaceControlLease(result.lease)
        : null;
      if (nextLease) adoptLease(nextLease);
      if (result?.ok) {
        // A later success is not the kept input arriving: only Retry or the
        // person moving on retires that (see `sendInput`).
        setInputNotice((current) =>
          current === 'host-busy' && undeliveredRef.current ? current : null,
        );
      } else if (result && !result.ok && result.code === 'invalid-source') {
        source.open = null;
        discardRefusedInput('input-failed');
      } else if (
        result &&
        !result.ok &&
        (result.code === 'stale-epoch' || result.code === 'stale-fence')
      ) {
        discardRefusedInput('control-changed');
      } else if (result && !result.ok && result.code === 'page-dialog-open') {
        queueRef.current = [];
        keepUndelivered([]);
        setInputNotice('page-dialog');
      } else {
        // Indeterminate: the event that failed may have taken effect before
        // its error or timeout (`accepted` counts only completed ones), and
        // what follows it would land after a gap. Nothing is kept to send
        // again; the person checks the page.
        keepUndelivered([]);
        queueRef.current = [];
        setInputNotice('input-failed');
      }
    } catch {
      if (generation !== targetGenerationRef.current) return;
      // The response was lost: the batch may have been applied.
      keepUndelivered([]);
      queueRef.current = [];
      setInputNotice('input-failed');
    } finally {
      if (generation === targetGenerationRef.current)
        inFlightRef.current = false;
    }
    if (queueRef.current.length > 0) void flush();
  }, [adoptLease, showHostBusy, keepUndelivered, discardRefusedInput]);

  const sendInput = useCallback(
    (events: LiveSurfaceInput[]) => {
      for (const event of normalizeEvents(events)) {
        const id = pressId(event);
        const kept = undeliveredRef.current;
        if (kept) {
          const continuesGesture =
            kept.open.size > 0 &&
            kept.events.length < LIVE_SURFACE_INPUT_MAX_EVENTS &&
            ((event.kind === 'pointer' && event.type === 'move') ||
              (id !== null && isRelease(event) && kept.open.has(id)));
          if (continuesGesture) {
            // The moves and release of a press that is kept join it, so
            // Retry sends the whole gesture and its release never goes out
            // alone (a no-op success that would stand in for the press).
            kept.events.push(event);
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
        if (id && isRelease(event) && orphanedRef.current.delete(id)) continue;
        if (id && !isRelease(event)) {
          // A fresh press (including a held key's auto-repeat) is new input:
          // its release is no longer the orphan the server cancelled.
          orphanedRef.current.delete(id);
          pressedRef.current.add(id);
        }
        if (id && isRelease(event)) pressedRef.current.delete(id);
        const queue = queueRef.current;
        const last = queue[queue.length - 1];
        if (
          event.kind === 'pointer' &&
          event.type === 'move' &&
          last?.kind === 'pointer' &&
          last.type === 'move'
        ) {
          queue[queue.length - 1] = event;
        } else {
          queue.push(event);
        }
      }
      if (!flushScheduledRef.current) {
        flushScheduledRef.current = true;
        queueMicrotask(() => void flush());
      }
    },
    [flush],
  );

  const retryInput = useCallback(() => {
    const kept = undeliveredRef.current;
    keepUndelivered([]);
    if (!kept) return;
    setInputNotice(null);
    // Meant for an epoch that has since ended: control changed hands.
    if (kept.epoch !== epochRef.current) return;
    const events = kept.events;
    // Ahead of anything typed since: it was meant to arrive first.
    queueRef.current = [...events, ...queueRef.current];
    if (!flushScheduledRef.current) {
      flushScheduledRef.current = true;
      queueMicrotask(() => void flush());
    }
  }, [flush, keepUndelivered]);

  const claimControl = useCallback(async () => {
    const generation = targetGenerationRef.current;
    try {
      const response = await transportRef.current(
        `${apiBase}/api/live-surfaces/${encodeURIComponent(surfaceId)}/lease${contextQuery(projectSlug)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'claim' }),
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
      if (!nextLease) return;
      adoptLease(nextLease);
    } catch {
      if (generation === targetGenerationRef.current)
        setInputNotice('input-failed');
    }
  }, [apiBase, surfaceId, projectSlug, adoptLease, showHostBusy]);

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
    retryableInput,
    retryInput,
    claimControl,
    releaseControl,
    keepControlAlive,
    retry,
  };
}
