import {
  LIVE_SURFACE_INPUT_MAX_BODY_BYTES,
  LIVE_SURFACE_INPUT_MAX_EVENTS,
  LIVE_SURFACE_TEXT_MAX_LENGTH,
  type LiveSurfaceControlLease,
  type LiveSurfaceFrameHeader,
  type LiveSurfaceInput,
  type LiveSurfaceInputResult,
  type LiveSurfaceLeaseResult,
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
  useRef,
  useState,
} from 'react';

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
 * - Reconnects with capped exponential backoff after a drop; a 404/403 is a
 *   typed terminal state, not something to hammer.
 * - Input is coalesced (consecutive moves collapse to the latest) and sent
 *   one POST at a time, each bounded to fit one relay chunk. A batch
 *   refused as `stale-epoch` is DROPPED, not replayed: it was aimed at a view
 *   that changed hands, and replaying clicks onto a page someone else has
 *   since changed is exactly what the epoch exists to prevent. Anything this
 *   client held down when that happened was already released by the server
 *   at the handoff, so its eventual button/key UP is swallowed here: sending
 *   it would be fresh human input, and would take control straight back.
 * - The epoch this client acts on only moves forward (it is the max of every
 *   epoch it has seen), so a frame published before a handoff can never
 *   walk it back behind a state record that already announced the handoff.
 * - Liveness counts BYTES, not records: a large frame still arriving over a
 *   slow relay is a live stream, not a stalled one.
 */

export type LiveSurfaceConnectionStatus =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'suspended'
  | 'unavailable'
  | 'denied';

export type LiveSurfaceInputNotice = 'control-changed' | 'input-failed' | null;

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
  /** Element whose on-screen visibility gates the stream. */
  visibilityRef: RefObject<Element | null>;
  onFrame: (frame: LiveSurfaceFrame) => void;
  /** Test seam; defaults to the SDK's `authenticatedFetch`. */
  transport?: typeof authenticatedFetch;
  now?: () => number;
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
  inputNotice: LiveSurfaceInputNotice;
  sendInput: (events: LiveSurfaceInput[]) => void;
  claimControl: () => Promise<void>;
  retry: () => void;
}

const LIVE_SURFACE_RECONNECT_DELAYS_MS = [
  500, 1_000, 2_000, 4_000, 8_000, 10_000,
] as const;

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () =>
      typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

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

function streamUrl(
  apiBase: string,
  surfaceId: string,
  params: Partial<LiveSurfaceStreamParams> | undefined,
): string {
  const query = new URLSearchParams();
  for (const key of ['maxFps', 'quality', 'maxWidth', 'maxHeight'] as const) {
    const value = params?.[key];
    if (value !== undefined) query.set(key, String(Math.round(value)));
  }
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
    visibilityRef,
    transport = authenticatedFetch,
    now = Date.now,
  } = options;
  const onFrameRef = useRef(options.onFrame);
  onFrameRef.current = options.onFrame;
  const nowRef = useRef(now);
  nowRef.current = now;
  const transportRef = useRef(transport);
  transportRef.current = transport;

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
  const [inputNotice, setInputNotice] = useState<LiveSurfaceInputNotice>(null);
  const [retryToken, setRetryToken] = useState(0);
  const epochRef = useRef(0);

  const observeEpoch = useCallback((epoch: number) => {
    epochRef.current = Math.max(epochRef.current, epoch);
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
    const abort = new AbortController();
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const url = streamUrl(apiBase, surfaceId, params);

    const scheduleReconnect = () => {
      if (stopped) return;
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

    const connect = async () => {
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
      try {
        while (!stopped) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value.byteLength > 0) setLastActivityAt(nowRef.current());
          for (const record of decoder.push(chunk.value)) {
            const receivedAt = nowRef.current();
            attempt = 0;
            setStatus('live');
            if (record.kind === 'state') {
              adoptLease(record.state.lease);
              setEffectiveParams(record.state.effectiveParams);
              setWedged(record.state.wedged === true);
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
      if (timer) clearTimeout(timer);
    };
  }, [
    apiBase,
    surfaceId,
    paramsKey,
    visible,
    retryToken,
    adoptLease,
    observeEpoch,
  ]);

  // ---- input -------------------------------------------------------------
  const queueRef = useRef<LiveSurfaceInput[]>([]);
  /** Buttons/keys this client pressed and has not released. */
  const pressedRef = useRef(new Set<string>());
  /** Pressed when control changed hands; the server released them already. */
  const orphanedRef = useRef(new Set<string>());
  const inFlightRef = useRef(false);
  const flushScheduledRef = useRef(false);
  const inputUrl = `${apiBase}/api/live-surfaces/${encodeURIComponent(surfaceId)}/input`;
  const inputUrlRef = useRef(inputUrl);
  inputUrlRef.current = inputUrl;

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
    try {
      const response = await transportRef.current(inputUrlRef.current, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      const envelope = (await response.json().catch(() => null)) as {
        data?: LiveSurfaceInputResult;
      } | null;
      const result = envelope?.data;
      const nextLease = result
        ? parseLiveSurfaceControlLease(result.lease)
        : null;
      if (nextLease) adoptLease(nextLease);
      if (result?.ok) {
        setInputNotice(null);
      } else if (result && !result.ok && result.code === 'stale-epoch') {
        queueRef.current = [];
        for (const id of pressedRef.current) orphanedRef.current.add(id);
        pressedRef.current.clear();
        setInputNotice('control-changed');
      } else {
        queueRef.current = [];
        setInputNotice('input-failed');
      }
    } catch {
      queueRef.current = [];
      setInputNotice('input-failed');
    } finally {
      inFlightRef.current = false;
    }
    if (queueRef.current.length > 0) void flush();
  }, [adoptLease]);

  const sendInput = useCallback(
    (events: LiveSurfaceInput[]) => {
      for (const event of normalizeEvents(events)) {
        const id = pressId(event);
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

  const claimControl = useCallback(async () => {
    try {
      const response = await transportRef.current(
        `${apiBase}/api/live-surfaces/${encodeURIComponent(surfaceId)}/lease`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'claim' }),
        },
      );
      const envelope = (await response.json().catch(() => null)) as {
        data?: LiveSurfaceLeaseResult;
      } | null;
      const nextLease = envelope?.data
        ? parseLiveSurfaceControlLease(envelope.data.lease)
        : null;
      if (!nextLease) return;
      adoptLease(nextLease);
    } catch {
      setInputNotice('input-failed');
    }
  }, [apiBase, surfaceId, adoptLease]);

  const retry = useCallback(() => setRetryToken((value) => value + 1), []);

  return {
    status,
    lease,
    effectiveParams,
    lastActivityAt,
    lastFrameAt,
    self,
    wedged,
    inputNotice,
    sendInput,
    claimControl,
    retry,
  };
}
