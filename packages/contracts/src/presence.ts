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
  /**
   * The sessions this document shows on screen right now: the open chat's
   * ids (its execution session, conversation, chat key), at most
   * {@link FOCUS_VIEWING_SESSION_IDS_MAX}, each matching
   * {@link FOCUS_VIEWING_SESSION_ID_PATTERN}. `[]` means no chat is on
   * screen. Absent means the client does not report it, and focus applies to
   * the whole surface as before. A focused document that reports it quiets a
   * `done` or `info` notification on the person's other surfaces only when
   * it is showing that notification's session.
   *
   * A host built before this field answers 400 to a report carrying it; the
   * client then reports without it.
   */
  viewingSessionIds?: string[];
  /**
   * The local Project (`ProjectConfig.id`) this document has in the
   * foreground (#5072), matching {@link FOCUS_VIEWING_SESSION_ID_PATTERN}.
   * A focused document that reports it quiets `done` and `info`
   * notifications about that Project's work, like a session it shows.
   * Absent: no Project on screen, or a client that does not report it.
   *
   * A host built before this field answers 400 to a report carrying it; the
   * client then reports without it.
   */
  viewingProjectId?: string;
}

/** Bound on {@link FocusReport.viewingSessionIds}. */
export const FOCUS_VIEWING_SESSION_IDS_MAX = 4;
/** The grammar of one {@link FocusReport.viewingSessionIds} entry. */
export const FOCUS_VIEWING_SESSION_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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
  /**
   * When {@link state} is `focused`: the union of the sessions its focused
   * documents show. Absent when any focused document did not report what it
   * shows (an older client): the surface's focus is then not scoped to a
   * session.
   */
  readonly viewingSessionIds?: readonly string[];
  /**
   * When {@link state} is `focused`: the Projects its focused documents
   * have in the foreground (#5072). Absent when none reported one.
   */
  readonly viewingProjectIds?: readonly string[];
}

/** Surfaces with an unexpired report. An absent surface has no live report. */
export type FocusSnapshot = ReadonlyMap<SurfaceId, FocusSurfaceSnapshot>;
