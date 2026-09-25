/**
 * Focus presence: which of a person's surfaces is being looked at right now.
 *
 * Every UI client reports its own document focus; the server keys the report
 * by the surface it derives from the authenticated caller, never from the
 * body. Notification delivery (#2582) reads the snapshot to decide whether to
 * interrupt other surfaces.
 */

/** `POST` a {@link FocusReport}; the server answers 204 or an error. */
export const FOCUS_PRESENCE_REPORT_PATH = '/api/presence/focus';

/**
 * How long a report stays true without a newer one. Clients heartbeat well
 * inside this while focused; past it the surface reads as absent.
 */
export const FOCUS_PRESENCE_LEASE_MS = 120_000;

export const FOCUS_STATES = ['focused', 'visible', 'hidden'] as const;

/**
 * `focused` — the document has input focus. `visible` — on screen but another
 * window or app has focus. `hidden` — not on screen (background tab, minimised
 * window, backgrounded app).
 */
export type FocusState = (typeof FOCUS_STATES)[number];

/** The request body a UI client sends. */
export interface FocusReport {
  /** The reporting document's `X-Station-Client-Session` UUID. */
  clientSessionId: string;
  state: FocusState;
  /**
   * Per-document send counter: a positive safe integer, starting at 1 for
   * each `clientSessionId` and strictly increasing with every send, retries
   * included. The server ignores a report whose seq is not above the last
   * one it applied for that document, so a late older report cannot
   * overwrite a newer one.
   */
  seq: number;
}

/**
 * One delivery surface: a paired device (`device:<deviceId>`) or a local
 * operator client session (`local:<clientSessionId>`).
 */
export type SurfaceId = `device:${string}` | `local:${string}`;

/** A surface's current focus, reconciled across its live client sessions. */
export interface FocusSurfaceSnapshot {
  readonly surfaceId: SurfaceId;
  /**
   * Who the surface belongs to: the id of the principal Station resolves for
   * the reporting request (`PrincipalRef.id`, the same resolution every
   * orchestration route uses — ingress identity, a device's person binding,
   * the operator, or the device itself, in that resolver's precedence). Focus
   * on one principal's surface must only quiet that principal's surfaces.
   */
  readonly principalId: string;
  /** The strongest state any unexpired client session on it reported. */
  readonly state: FocusState;
  /** Epoch milliseconds of the newest report carrying {@link state}. */
  readonly reportedAt: number;
}

/** Surfaces with an unexpired report. An absent surface has no live report. */
export type FocusSnapshot = ReadonlyMap<SurfaceId, FocusSurfaceSnapshot>;
