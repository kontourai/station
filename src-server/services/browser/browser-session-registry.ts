/**
 * Server-owned Browser sessions (#90): one process per canonical Project/principal
 * profile under browser/profiles, never keyed by a reusable slug (D7).
 * Profiles separate cookies and network reach. Persisted generations invalidate
 * old references; exited/restarted sessions require explicit reopening.
 * The last live target closing starts idle shutdown; zero viewers only stop
 * capture. Bounded action history counts truncation even when nobody watches (D6).
 * See docs/guides/browser-workspace.md for lifecycle and authority boundaries.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, posix } from 'node:path';
import {
  type BrowserHost,
  type BrowserHostKind,
  type BrowserHostResolver,
  type BrowserTarget,
  type BrowserViewport,
  type CdpTransport,
  LOCAL_BROWSER_HOST_ID,
} from './browser-host.js';
import {
  ABOUT_BLANK,
  type BrowserUrlRejection,
  isAllowedBrowserUrl,
  normalizeBrowserUrl,
} from './url-policy.js';

export type BrowserSessionState =
  | 'opening'
  | 'live'
  | 'closed'
  | 'needs-reopen';

export type BrowserSessionEndReason =
  | 'closed'
  | 'host-exited'
  | 'server-stopped'
  | 'server-restarted';

/** Who caused a session action. Authority is decided by the caller, not here. */
export type BrowserSessionActor =
  | { kind: 'operator' }
  | { kind: 'project-admin'; principalId: string }
  | { kind: 'agent'; principalId?: string; sessionId: string }
  | { kind: 'system' };

export type BrowserSessionActionKind =
  | 'created'
  | 'navigated'
  | 'navigation-refused'
  | 'closed'
  | 'reopened'
  | 'host-exited'
  | 'server-stopped'
  | 'server-restarted'
  // Added by the Browser pane lane (#90 wave 2).
  | 'history-navigated'
  | 'reloaded'
  | 'viewport-changed'
  | 'page-navigated'
  | 'dialog-handled'
  // A person answered a JavaScript dialog Station held for them (the
  // actor is that person). A prompt's typed answer is never recorded.
  | 'dialog-answered'
  // A main-frame navigation that followed someone's input (a link click).
  | 'link-followed'
  // A navigation Station refused because it is one of Station's own
  // services (recorded as such for the operator only; see `navigate`).
  | 'navigation-blocked'
  // An agent's browser tool actions (#90 #122/#123), always with an agent
  // actor (`recordAgentAction`). Typed text and scripts are never recorded,
  // only their size.
  | 'clicked'
  | 'typed'
  | 'key-pressed'
  | 'scrolled'
  | 'inspected'
  | 'script-evaluated'
  // An agent moved a session it opened into the conversation it acts in.
  | 'thread-adopted'
  // A browser tool call Station refused (detail: the reason code). Recorded
  // so the history shows what an agent TRIED, never counted as driving.
  | 'agent-refused'
  // A person took control of the live view, or their control ended.
  | 'control-taken'
  | 'control-released';

/** The kinds `recordAgentAction` accepts; every other kind has its own writer. */
const BROWSER_AGENT_ACTION_KINDS: ReadonlySet<BrowserSessionActionKind> =
  new Set([
    'clicked',
    'typed',
    'key-pressed',
    'scrolled',
    'inspected',
    'script-evaluated',
    'thread-adopted',
  ]);

export interface BrowserSessionAction {
  seq: number;
  at: string;
  kind: BrowserSessionActionKind;
  actor: BrowserSessionActor;
  url?: string;
  generation?: number;
  detail?: string;
  /**
   * Page-originated entries (`dialog-handled`, `page-navigated`) repeated in
   * a burst are folded into one entry; this counts them. Absent means 1.
   */
  count?: number;
  /**
   * For a `link-followed` entry: whose input the page's navigation followed.
   * Provenance only — the entry itself is the page's (a navigation after
   * someone's click is not proof they chose it), so it never counts as that
   * actor driving the session.
   */
  cause?: BrowserSessionActor;
  /**
   * A navigation the browser reported as failed (its error text is the
   * detail). Recorded, but not an agent input: it never stamps
   * `lastAgentInputAt`.
   */
  failed?: true;
}

/**
 * Entries that are history but not driving: a refused call changed nothing,
 * and control ending is not an action on the page.
 */
const NON_DRIVING_KINDS: ReadonlySet<BrowserSessionActionKind> = new Set([
  'agent-refused',
  'control-released',
]);

/** An agent's successful input or navigation: what "an agent is driving" means. */
const AGENT_INPUT_KINDS: ReadonlySet<BrowserSessionActionKind> = new Set([
  'clicked',
  'typed',
  'key-pressed',
  'scrolled',
  'navigated',
  'history-navigated',
  'reloaded',
  'script-evaluated',
]);

/** What the session's history says about who drove it (D6, S5). */
export interface BrowserSessionActivity {
  /** The latest non-Station actor, derived when each action is recorded. */
  lastDriver?: BrowserSessionActor;
  /**
   * When an agent's latest successful input or navigation was recorded
   * (server time). Clients derive "an agent is driving" from it.
   */
  lastAgentInputAt?: string;
  /** Whether an agent has ever acted in this session. Never lost to eviction. */
  agentDriven: boolean;
  /** The latest JavaScript dialog Station answered for the page. */
  lastDialog?: {
    seq: number;
    at: string;
    type: string;
    message: string;
    accepted: boolean;
    count: number;
    /**
     * It was held for a person, and answered automatically because nobody
     * answered in time. Absent: answered the moment it opened.
     */
    unanswered?: true;
    /** Held for a person, and dismissed when their control ended. */
    controlEnded?: true;
  };
}

export interface BrowserSessionHistory {
  /** The most recent actions, oldest first. */
  entries: BrowserSessionAction[];
  /** Total actions ever recorded; `total - entries.length` were dropped. */
  total: number;
}

/** Network reach of a profile's browser (D7), enforced by its egress proxy. */
export type BrowserProfileReach = 'operator' | 'project';

/** One browser profile: one process, one proxy, one cookie jar. */
export interface BrowserProfile {
  /** Canonical Project ID (not the slug). */
  projectId: string;
  /** `operator` or `principal:<id>`. */
  principalKey: string;
  reach: BrowserProfileReach;
  /** Map key for the profile. */
  key: string;
  /** Home-relative, `/`-separated profile directory. */
  profileRef: string;
}

export interface BrowserSessionRecord {
  browserSessionId: string;
  /** Canonical Project ID; authorization and the profile key use this. */
  projectId: string;
  /** The Project's slug when the session was created (display only). */
  projectSlug: string;
  /** Whose profile the session runs in (D7). */
  principalKey: string;
  reach: BrowserProfileReach;
  threadId?: string;
  url: string;
  viewport: BrowserViewport;
  generation: number;
  hostKind: BrowserHostKind;
  /** Which Station runs this session's browser (#90 D13); `local` today. */
  hostId: string;
  /** Profile directory relative to the Station home. */
  profileRef: string;
  state: BrowserSessionState;
  endReason?: BrowserSessionEndReason;
  createdAt: string;
  updatedAt: string;
  history: BrowserSessionHistory;
  activity: BrowserSessionActivity;
}

/** List-view projection: the record with only the latest few actions. */
export interface BrowserSessionSummary
  extends Omit<BrowserSessionRecord, 'history'> {
  history: BrowserSessionHistory & { omittedFromSummary: number };
}

/**
 * Bound on actor and lifecycle entries. Page-originated noise has its own
 * bound below, so a page cannot evict what people and agents did (B1).
 */
export const BROWSER_SESSION_HISTORY_LIMIT = 200;
/** Bound on page-originated entries (dialogs, the page's own navigations). */
export const BROWSER_SESSION_PAGE_NOISE_LIMIT = 50;
/**
 * Bound on an agent's refused calls (review M1). They have their own bound
 * and fold, so an agent retrying against a person's control can never evict
 * what people and agents actually did — `created` included, which
 * `adoptThread` reads.
 */
const BROWSER_SESSION_REFUSAL_LIMIT = 20;
/** A repeat of the same page-originated entry inside this window folds. */
const PAGE_NOISE_FOLD_MS = 10_000;
/** Page-originated entries are written to disk at most this often. */
const PAGE_NOISE_PERSIST_MS = 1_000;
const BROWSER_SESSION_SUMMARY_ACTIONS = 5;

const PAGE_NOISE_KINDS: ReadonlySet<BrowserSessionActionKind> = new Set([
  'dialog-handled',
  'page-navigated',
  'link-followed',
]);

function emptyActivity(): BrowserSessionActivity {
  return { agentDriven: false };
}
const SYSTEM: BrowserSessionActor = { kind: 'system' };

export type BrowserSessionErrorCode =
  | 'url-not-allowed'
  | 'invalid-project'
  | 'invalid-viewport'
  | 'invalid-actor'
  | 'not-found'
  | 'not-live'
  | 'stale-generation'
  | 'no-history-entry'
  | 'page-busy'
  | 'screenshot-too-large'
  | 'stopped';

export class BrowserSessionError extends Error {
  constructor(
    readonly code: BrowserSessionErrorCode,
    message: string,
    readonly detail?: {
      urlRejection?: BrowserUrlRejection;
      generation?: number;
    },
  ) {
    super(message);
    this.name = 'BrowserSessionError';
  }
}

const DEFAULT_BROWSER_VIEWPORT: BrowserViewport = {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
};

const DEFAULT_BROWSER_IDLE_SHUTDOWN_MS = 60_000;

/** A person's screenshot of the page must answer within this. */
const SCREENSHOT_DEADLINE_MS = 10_000;
/**
 * The most a screenshot may weigh (decoded bytes). A 4096 px viewport at a
 * high device scale can exceed it as PNG; it is then taken as JPEG, and
 * refused (`screenshot-too-large`) if that is still over, never cut.
 */
const BROWSER_SCREENSHOT_MAX_BYTES = 16 * 1024 * 1024;

const STORE_VERSION = 2;
const MAX_STORED_SESSIONS = 500;
const CLOSED_RETENTION_MS = 24 * 60 * 60 * 1000;
const PROJECT_SLUG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Why a viewport is refused, naming the field, or undefined when valid. The
 * one definition behind {@link isValidBrowserViewport}, so the answer an API
 * caller reads cannot drift from the check that refuses.
 */
export function browserViewportProblem(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return 'viewport must be an object with width, height and deviceScaleFactor';
  const v = value as Record<string, unknown>;
  for (const key of ['width', 'height'] as const) {
    const n = v[key];
    if (n === undefined) return `viewport.${key} is required`;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 100 || n > 4096)
      return `viewport.${key} must be an integer from 100 to 4096`;
  }
  const scale = v.deviceScaleFactor;
  if (scale === undefined) return 'viewport.deviceScaleFactor is required';
  if (
    typeof scale !== 'number' ||
    !Number.isFinite(scale) ||
    scale < 0.5 ||
    scale > 4
  )
    return 'viewport.deviceScaleFactor must be a number from 0.5 to 4';
  if (v.mobile !== undefined && typeof v.mobile !== 'boolean')
    return 'viewport.mobile must be a boolean';
  const unknown = Object.keys(v).find(
    (key) => !['width', 'height', 'deviceScaleFactor', 'mobile'].includes(key),
  );
  if (unknown !== undefined)
    // The key is caller-supplied; cap what is echoed back.
    return `viewport.${unknown.length > 64 ? `${unknown.slice(0, 64)}...` : unknown} is not a viewport field`;
  return undefined;
}

export function isValidBrowserViewport(
  value: unknown,
): value is BrowserViewport {
  return browserViewportProblem(value) === undefined;
}

export function isValidBrowserProjectId(
  projectId: unknown,
): projectId is string {
  return (
    typeof projectId === 'string' &&
    PROJECT_SLUG.test(projectId) &&
    projectId !== '.' &&
    projectId !== '..'
  );
}

/** The profile principal for an actor; undefined when it may own none. */
function principalKeyFor(actor: BrowserSessionActor): string | undefined {
  switch (actor.kind) {
    case 'operator':
      return 'operator';
    case 'project-admin':
      return `principal:${actor.principalId}`;
    case 'agent':
      return actor.principalId ? `principal:${actor.principalId}` : undefined;
    case 'system':
      return undefined;
  }
}

const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 32);

/**
 * The profile an actor's session in a Project runs in. The directory is
 * derived from digests so any id or principal spelling is path-safe.
 */
export function browserProfileFor(
  projectId: string,
  actor: BrowserSessionActor,
): BrowserProfile | undefined {
  const principalKey = principalKeyFor(actor);
  if (!principalKey) return undefined;
  return {
    projectId,
    principalKey,
    reach: principalKey === 'operator' ? 'operator' : 'project',
    key: `${projectId}\u001f${principalKey}`,
    profileRef: posix.join(
      'browser',
      'profiles',
      digest(projectId),
      digest(principalKey),
    ),
  };
}

/**
 * Whether an already Project-authorized actor may see this session (D7): the
 * operator sees every session; anyone else only sessions in their own profile.
 */
export function actorOwnsSessionProfile(
  record: Pick<BrowserSessionRecord, 'principalKey'>,
  actor: BrowserSessionActor,
): boolean {
  if (actor.kind === 'operator') return true;
  const key = principalKeyFor(actor);
  return key !== undefined && key === record.principalKey;
}

/** Drop query and fragment: list and summary views never carry them (S4). */
export function redactBrowserUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export function browserProfileDir(
  stationHome: string,
  profileRef: string,
): string {
  return join(stationHome, ...profileRef.split('/'));
}

export interface BrowserSessionRegistryOptions {
  stationHome: string;
  hostKind?: BrowserHostKind;
  /**
   * The one path to a browser host (#90 D13): one new host per launch; the
   * registry never reuses an exited host.
   */
  hostResolver: BrowserHostResolver;
  idleShutdownMs?: number;
  now?: () => Date;
  newId?: () => string;
  /** Whether a URL is one of this Station's own listeners (D2 wording). */
  isStationAddress?: (url: string) => boolean;
  /** Test seams for the screenshot bounds. */
  screenshotDeadlineMs?: number;
  screenshotMaxBytes?: number;
}

/** A navigation this soon after someone's input is theirs (a link click). */
const INPUT_ATTRIBUTION_MS = 3_000;

interface HostEntry {
  host: BrowserHost;
  generation: number;
  targets: Map<string, BrowserTarget>;
  idleTimer?: NodeJS.Timeout;
  offExit: () => void;
}

/** A live session's page, for a producer that streams and drives it. */
export interface BrowserLiveTarget {
  host: BrowserHost;
  target: BrowserTarget;
  generation: number;
}

export type BrowserHistoryDirection = 'back' | 'forward' | 'reload';

interface StoreShape {
  version: number;
  generations: Record<string, number>;
  sessions: BrowserSessionRecord[];
}

export class BrowserSessionRegistry {
  private readonly sessions = new Map<string, BrowserSessionRecord>();
  private readonly generations = new Map<string, number>();
  private readonly hosts = new Map<string, HostEntry>();
  private readonly starting = new Map<string, Promise<HostEntry>>();
  /** Attaches in flight per profile; an idle shutdown waits for them. */
  private readonly reservations = new Map<string, number>();
  private readonly changeListeners = new Set<
    (record: BrowserSessionRecord) => void
  >();
  /** The URL an explicit navigate is loading, per session. */
  private readonly inflightNavigations = new Map<string, string>();
  /** A screenshot in flight per session; a second request joins it. */
  private readonly inflightShots = new Map<
    string,
    Promise<{ mimeType: 'image/png' | 'image/jpeg'; data: Buffer }>
  >();
  /** Who last sent input into each session, and when. */
  private readonly lastInput = new Map<
    string,
    { actor: BrowserSessionActor; at: number }
  >();
  private stopped = false;
  private persistTimer: NodeJS.Timeout | undefined;
  /** Raised above every stored value when the store was unreadable. */
  private generationFloor = 0;
  private readonly storePath: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly hostKind: BrowserHostKind;
  private readonly hostResolver: BrowserHostResolver;

  constructor(private readonly options: BrowserSessionRegistryOptions) {
    this.storePath = join(options.stationHome, 'browser', 'sessions.json');
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => `bs_${randomUUID()}`);
    this.hostKind = options.hostKind ?? 'server-chromium';
    this.hostResolver = options.hostResolver;
    this.load();
  }

  getSession(browserSessionId: string): BrowserSessionRecord | undefined {
    const record = this.sessions.get(browserSessionId);
    return record ? structuredClone(record) : undefined;
  }

  /** Every session (any state), newest first, with a history summary. */
  listSessions(
    filter?: (record: BrowserSessionRecord) => boolean,
  ): BrowserSessionSummary[] {
    return [...this.sessions.values()]
      .filter((record) => filter === undefined || filter(record))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((record) => summarize(record));
  }

  /**
   * One session's summary: the whole record except that only the latest few
   * actions travel. What a pane polls; the full history is fetched on demand.
   */
  getSessionSummary(
    browserSessionId: string,
  ): BrowserSessionSummary | undefined {
    const record = this.sessions.get(browserSessionId);
    return record ? summarize(record) : undefined;
  }

  /**
   * Observe every session change (state, generation, URL, history). The
   * listener gets a copy; a throwing listener is isolated from the others.
   */
  onSessionChange(
    listener: (record: BrowserSessionRecord) => void,
  ): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /** The running page behind a LIVE session, else undefined. */
  liveTarget(browserSessionId: string): BrowserLiveTarget | undefined {
    const record = this.sessions.get(browserSessionId);
    if (record?.state !== 'live') return undefined;
    const entry = this.hosts.get(this.keyOf(record));
    const target = entry?.targets.get(browserSessionId);
    if (!entry || !target || entry.generation !== record.generation)
      return undefined;
    return {
      host: entry.host,
      target: { ...target },
      generation: entry.generation,
    };
  }

  /**
   * A still of the page as it is now (its viewport), for a person to save or
   * copy. PNG, or JPEG when the PNG would exceed the byte bound. Viewing is
   * not driving: nothing is recorded. A page that does not answer in time
   * (a hung script) is `page-busy`.
   */
  async captureScreenshot(
    browserSessionId: string,
  ): Promise<{ mimeType: 'image/png' | 'image/jpeg'; data: Buffer }> {
    // At most one capture per session: concurrent requests (a double click,
    // two viewers) share the one in flight rather than each asking the page.
    const inflight = this.inflightShots.get(browserSessionId);
    if (inflight) return inflight;
    const shot = this.captureScreenshotOnce(browserSessionId).finally(() => {
      if (this.inflightShots.get(browserSessionId) === shot)
        this.inflightShots.delete(browserSessionId);
    });
    this.inflightShots.set(browserSessionId, shot);
    return shot;
  }

  private async captureScreenshotOnce(
    browserSessionId: string,
  ): Promise<{ mimeType: 'image/png' | 'image/jpeg'; data: Buffer }> {
    this.assertRunning();
    this.requireLive(browserSessionId, undefined);
    const live = this.liveTarget(browserSessionId);
    if (!live)
      throw new BrowserSessionError(
        'not-live',
        'The session has no running browser.',
      );
    const cdp = live.host.cdp();
    const deadlineMs =
      this.options.screenshotDeadlineMs ?? SCREENSHOT_DEADLINE_MS;
    const maxBytes =
      this.options.screenshotMaxBytes ?? BROWSER_SCREENSHOT_MAX_BYTES;
    const capture = async (
      params: { format: 'png' } | { format: 'jpeg'; quality: number },
    ): Promise<Buffer> => {
      let timer: NodeJS.Timeout | undefined;
      const pending = cdp.send<{ data?: unknown }>(
        'Page.captureScreenshot',
        params,
        live.target.cdpSessionId,
      );
      try {
        const shot = await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new BrowserSessionError(
                    'page-busy',
                    'The page did not answer in time.',
                  ),
                ),
              deadlineMs,
            );
          }),
        ]);
        if (typeof shot?.data !== 'string')
          throw new BrowserSessionError(
            'page-busy',
            'The browser returned no image.',
          );
        return Buffer.from(shot.data, 'base64');
      } finally {
        if (timer) clearTimeout(timer);
        pending.catch(() => {});
      }
    };
    const png = await capture({ format: 'png' });
    if (png.length <= maxBytes) return { mimeType: 'image/png', data: png };
    const jpeg = await capture({ format: 'jpeg', quality: 85 });
    if (jpeg.length <= maxBytes) return { mimeType: 'image/jpeg', data: jpeg };
    throw new BrowserSessionError(
      'screenshot-too-large',
      'The screenshot is too large. Choose a smaller viewport and try again.',
    );
  }

  /** Back, forward or reload, within the session's own history. */
  async navigateHistory(
    browserSessionId: string,
    direction: BrowserHistoryDirection,
    options: { generation?: number; actor: BrowserSessionActor },
  ): Promise<BrowserSessionRecord> {
    this.assertRunning();
    const record = this.requireLive(browserSessionId, options.generation);
    const live = this.liveTarget(browserSessionId);
    if (!live) {
      throw new BrowserSessionError(
        'not-live',
        'The session has no running browser.',
      );
    }
    const cdp = live.host.cdp();
    const session = live.target.cdpSessionId;
    if (direction === 'reload') {
      await this.whileNavigating(browserSessionId, record.url, () =>
        cdp.send('Page.reload', {}, session),
      );
      this.requireLive(browserSessionId, record.generation);
      this.record(record, 'reloaded', options.actor, { url: record.url });
      return structuredClone(record);
    }
    const history = await cdp.send<{
      currentIndex: number;
      entries: Array<{ id: number; url: string }>;
    }>('Page.getNavigationHistory', {}, session);
    const entries = Array.isArray(history?.entries) ? history.entries : [];
    const index = Number.isInteger(history?.currentIndex)
      ? history.currentIndex
      : -1;
    const entry =
      index < 0 ? undefined : entries[index + (direction === 'back' ? -1 : 1)];
    if (!entry) {
      throw new BrowserSessionError(
        'no-history-entry',
        `There is no page to go ${direction} to.`,
      );
    }
    // The host refuses an entry whose URL is out of scope. Marked in flight
    // so the page's own commit of it is not recorded a second time.
    await this.whileNavigating(browserSessionId, entry.url, () =>
      cdp.send('Page.navigateToHistoryEntry', { entryId: entry.id }, session),
    );
    this.requireLive(browserSessionId, record.generation);
    // Actor-driven: the person or agent chose this entry, so its full URL is
    // kept (only page-originated URLs are redacted).
    record.url = entry.url;
    this.record(record, 'history-navigated', options.actor, {
      url: entry.url,
      detail: direction,
    });
    return structuredClone(record);
  }

  /** Resize (or switch device emulation for) a live session's page. */
  async setViewport(
    browserSessionId: string,
    viewport: BrowserViewport,
    options: { generation?: number; actor: BrowserSessionActor },
  ): Promise<BrowserSessionRecord> {
    this.assertRunning();
    if (!isValidBrowserViewport(viewport)) {
      throw new BrowserSessionError(
        'invalid-viewport',
        'The viewport is not valid.',
      );
    }
    const record = this.requireLive(browserSessionId, options.generation);
    const live = this.liveTarget(browserSessionId);
    if (!live) {
      throw new BrowserSessionError(
        'not-live',
        'The session has no running browser.',
      );
    }
    const cdp = live.host.cdp();
    const session = live.target.cdpSessionId;
    const mobile = viewport.mobile === true;
    const previous = record.viewport;
    try {
      await applyViewport(cdp, session, viewport);
    } catch (error) {
      // All or nothing: a half-applied emulation (new size, old touch mode)
      // must not outlive the refusal. Best effort; the original error wins.
      await applyViewport(cdp, session, previous).catch(() => {});
      throw error;
    }
    this.requireLive(browserSessionId, record.generation);
    record.viewport = { ...viewport };
    this.record(record, 'viewport-changed', options.actor, {
      detail: `${viewport.width}x${viewport.height}@${viewport.deviceScaleFactor}${mobile ? ' mobile' : ''}`,
    });
    return structuredClone(record);
  }

  /**
   * The page committed a main-frame URL (a link, a redirect, script). An
   * explicit navigate records its own action; anything else is recorded
   * here, so the history shows what the page did on its own (D6).
   */
  observeCommittedUrl(
    browserSessionId: string,
    generation: number,
    url: string,
  ): void {
    const record = this.sessions.get(browserSessionId);
    if (
      !record ||
      record.state !== 'live' ||
      record.generation !== generation ||
      !isAllowedBrowserUrl(url)
    )
      return;
    // A reload of a page whose URL was adopted redacted commits the full URL;
    // the redacted comparison below already treats it as the same page.
    if (this.inflightNavigations.get(browserSessionId) === url) return;
    // A page-originated URL may carry tokens in its query or fragment: it is
    // neither recorded nor adopted as the reopen URL with them (S2).
    const redacted = redactBrowserUrl(url);
    if (redacted === record.url) return;
    record.url = redacted;
    // Armed by a click, key or text only; consumed by the first commit.
    const input = this.lastInput.get(browserSessionId);
    this.lastInput.delete(browserSessionId);
    if (input && this.now().getTime() - input.at <= INPUT_ATTRIBUTION_MS) {
      // Still a PAGE entry (the page navigated), with the input as its
      // provenance: a page cannot forge actor history or lastDriver by
      // redirecting after someone clicks.
      this.recordPageNoise(record, 'link-followed', {
        url: redacted,
        cause: input.actor,
      });
      return;
    }
    this.recordPageNoise(record, 'page-navigated', { url: redacted });
  }

  /**
   * Someone sent input into the live page. A main-frame navigation shortly
   * after is attributed to them as a followed link, not to the page.
   */
  noteInput(browserSessionId: string, actor: BrowserSessionActor): void {
    this.lastInput.set(browserSessionId, {
      actor: structuredClone(actor),
      at: this.now().getTime(),
    });
  }

  /**
   * Record one browser-tool action an agent took in a LIVE session (D6), on
   * the generation it ran against. Only agent actors and the agent action
   * kinds are accepted: the pane shows these as the agent's own doing.
   */
  recordAgentAction(
    browserSessionId: string,
    generation: number,
    kind: BrowserSessionActionKind,
    actor: BrowserSessionActor,
    extra: { url?: string; detail?: string } = {},
  ): void {
    if (actor.kind !== 'agent' || !BROWSER_AGENT_ACTION_KINDS.has(kind)) {
      throw new BrowserSessionError(
        'invalid-actor',
        'Only an agent records a browser tool action.',
      );
    }
    const record = this.sessions.get(browserSessionId);
    if (!record || record.generation !== generation) return;
    this.record(record, kind, actor, { ...extra, generation });
  }

  /**
   * Record a browser tool call Station refused an agent (D6: what it tried
   * stays visible), with the refusal's reason code. Recorded whatever the
   * session's state; never counted as the agent driving it.
   */
  recordAgentRefusal(
    browserSessionId: string,
    actor: BrowserSessionActor,
    code: string,
  ): void {
    if (actor.kind !== 'agent')
      throw new BrowserSessionError(
        'invalid-actor',
        'Only an agent is refused a browser tool call.',
      );
    const record = this.sessions.get(browserSessionId);
    if (!record) return;
    // Review M1. A refused call changes nothing about the session, so it
    // neither moves `updatedAt` nor notifies, and it is written on the
    // page-noise debounce. Consecutive repeats (same agent session, same
    // reason) fold into one entry; `total` counts every refusal, so the
    // pane's "no longer kept" arithmetic (total minus each kept entry's
    // count) stays exact.
    const last = record.history.entries.at(-1);
    if (
      last?.kind === 'agent-refused' &&
      last.actor.kind === 'agent' &&
      last.actor.sessionId === actor.sessionId &&
      last.detail === code &&
      last.generation === record.generation
    ) {
      last.count = (last.count ?? 1) + 1;
      last.at = this.now().toISOString();
      record.history.total += 1;
    } else {
      this.append(record, 'agent-refused', actor, {
        detail: code,
        touch: false,
      });
    }
    this.persistSoon();
  }

  /** A person took control of a live session's view, or their control ended. */
  recordControlChange(
    browserSessionId: string,
    generation: number,
    kind: 'control-taken' | 'control-released',
    actor: BrowserSessionActor,
  ): void {
    if (actor.kind !== 'operator' && actor.kind !== 'project-admin')
      throw new BrowserSessionError(
        'invalid-actor',
        'Only a person takes or gives up control of a browser view.',
      );
    const record = this.sessions.get(browserSessionId);
    if (!record || record.generation !== generation) return;
    this.record(record, kind, actor, { generation });
  }

  /**
   * Bind a session to the conversation acting in it (an agent opening or
   * reusing it), so the chat that asked can find and float it. The caller
   * supplies a verified id; this never reads one from a request.
   */
  setSessionThread(browserSessionId: string, threadId: string): void {
    const record = this.sessions.get(browserSessionId);
    if (!record || record.threadId === threadId) return;
    record.threadId = threadId;
    this.touch(record);
  }

  /** The screencast producer answered a JavaScript dialog (D6). */
  recordDialog(
    browserSessionId: string,
    generation: number,
    dialog: {
      type: string;
      message: string;
      accepted: boolean;
      unanswered?: true;
      controlEnded?: true;
    },
  ): void {
    const record = this.sessions.get(browserSessionId);
    if (!record || record.generation !== generation) return;
    this.appendDialog(record, dialog);
  }

  /**
   * A person answered a dialog Station held for them. Their answer is an
   * action on the page (it counts as them driving); a prompt's text is not
   * recorded, only that it was answered.
   */
  recordDialogAnswer(
    browserSessionId: string,
    generation: number,
    dialog: { type: string; message: string; accepted: boolean },
    actor: BrowserSessionActor,
  ): void {
    if (actor.kind !== 'operator' && actor.kind !== 'project-admin')
      throw new BrowserSessionError(
        'invalid-actor',
        "Only a person answers a page's dialog.",
      );
    const record = this.sessions.get(browserSessionId);
    if (!record || record.generation !== generation) return;
    const message = dialog.message.slice(0, 300);
    this.record(record, 'dialog-answered', actor, {
      generation,
      detail: `${dialog.type} ${dialog.accepted ? 'accepted' : 'dismissed'}${message ? `: ${message}` : ''}`,
    });
  }

  private appendDialog(
    record: BrowserSessionRecord,
    dialog: {
      type: string;
      message: string;
      accepted: boolean;
      unanswered?: true;
      controlEnded?: true;
    },
  ): void {
    const how = dialog.unanswered
      ? 'automatically after nobody answered it'
      : dialog.controlEnded
        ? "automatically when the person's control ended"
        : 'automatically';
    const entry = this.recordPageNoise(record, 'dialog-handled', {
      detail: `${dialog.type} ${dialog.accepted ? 'accepted' : 'dismissed'} ${how}${dialog.message ? `: ${dialog.message}` : ''}`,
    });
    record.activity.lastDialog = {
      seq: entry.seq,
      at: entry.at,
      type: dialog.type,
      message: dialog.message,
      accepted: dialog.accepted,
      count: entry.count ?? 1,
      ...(dialog.unanswered ? { unanswered: true as const } : {}),
      ...(dialog.controlEnded ? { controlEnded: true as const } : {}),
    };
  }

  /** Run a navigation with its target URL marked in flight. */
  private async whileNavigating<T>(
    browserSessionId: string,
    url: string,
    run: () => Promise<T>,
  ): Promise<T> {
    this.inflightNavigations.set(browserSessionId, url);
    try {
      return await run();
    } finally {
      if (this.inflightNavigations.get(browserSessionId) === url)
        this.inflightNavigations.delete(browserSessionId);
    }
  }

  /** Whether a profile currently has a running browser (diagnostics/tests). */
  hasRunningHost(projectId: string, principalKey = 'operator'): boolean {
    return this.hosts.has(`${projectId}\u001f${principalKey}`);
  }

  async createSession(input: {
    /** Canonical Project ID. */
    projectId: string;
    projectSlug: string;
    threadId?: string;
    url: string;
    viewport?: BrowserViewport;
    /** Who the session is recorded as opened by. */
    actor: BrowserSessionActor;
    /**
     * Whose profile it runs in, when that is not `actor` (D7): an agent acts
     * in the profile of the person it acts for, so an operator's agent uses
     * the operator's profile rather than one keyed on its principal id.
     */
    profileActor?: BrowserSessionActor;
  }): Promise<BrowserSessionRecord> {
    this.assertRunning();
    if (!isValidBrowserProjectId(input.projectId)) {
      throw new BrowserSessionError(
        'invalid-project',
        'The Project id is not valid.',
      );
    }
    const profile = browserProfileFor(
      input.projectId,
      input.profileActor ?? input.actor,
    );
    if (!profile) {
      throw new BrowserSessionError(
        'invalid-actor',
        'This caller cannot own a browser profile.',
      );
    }
    const url = this.normalize(input.url);
    const viewport = input.viewport ?? DEFAULT_BROWSER_VIEWPORT;
    if (!isValidBrowserViewport(viewport)) {
      throw new BrowserSessionError(
        'invalid-viewport',
        'The viewport is not valid.',
      );
    }
    const at = this.now().toISOString();
    const record: BrowserSessionRecord = {
      browserSessionId: this.newId(),
      projectId: input.projectId,
      projectSlug: input.projectSlug,
      principalKey: profile.principalKey,
      reach: profile.reach,
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      url,
      viewport: { ...viewport },
      generation: 0,
      hostKind: this.hostKind,
      hostId: LOCAL_BROWSER_HOST_ID,
      profileRef: profile.profileRef,
      state: 'opening',
      createdAt: at,
      updatedAt: at,
      history: { entries: [], total: 0 },
      activity: emptyActivity(),
    };
    this.sessions.set(record.browserSessionId, record);
    // Recorded before the attach so a close that lands while the browser is
    // still opening follows it in the history.
    this.append(record, 'created', input.actor, { url });
    const created = record.history.entries.at(-1);
    try {
      await this.attach(record);
    } catch (error) {
      this.sessions.delete(record.browserSessionId);
      this.persist();
      throw error;
    }
    if (created && record.state === 'live') {
      created.generation = record.generation;
      this.persist();
    }
    return structuredClone(record);
  }

  /** Re-open a session whose browser went away, on a new generation. */
  async reopenSession(
    browserSessionId: string,
    actor: BrowserSessionActor,
  ): Promise<BrowserSessionRecord> {
    this.assertRunning();
    const record = this.require(browserSessionId);
    if (record.state === 'live') return structuredClone(record);
    if (record.state !== 'needs-reopen') {
      throw new BrowserSessionError(
        'not-live',
        'Only a session that needs reopening can be reopened.',
      );
    }
    record.state = 'opening';
    delete record.endReason;
    try {
      await this.attach(record);
    } catch (error) {
      record.state = 'needs-reopen';
      record.endReason = 'host-exited';
      this.touch(record);
      throw error;
    }
    this.record(record, 'reopened', actor, { url: record.url });
    return structuredClone(record);
  }

  async navigate(
    browserSessionId: string,
    rawUrl: string,
    options: { generation?: number; actor: BrowserSessionActor },
  ): Promise<{ session: BrowserSessionRecord; errorText?: string }> {
    this.assertRunning();
    const record = this.requireLive(browserSessionId, options.generation);
    let url: string;
    try {
      url = this.normalize(rawUrl);
    } catch (error) {
      // A refused attempt is part of what happened in the session.
      this.record(record, 'navigation-refused', options.actor, {
        detail:
          error instanceof BrowserSessionError
            ? error.detail?.urlRejection
            : undefined,
      });
      throw error;
    }
    const entry = this.hosts.get(this.keyOf(record));
    const target = entry?.targets.get(record.browserSessionId);
    if (!entry || !target) {
      throw new BrowserSessionError(
        'not-live',
        'The session has no running browser.',
      );
    }
    this.inflightNavigations.set(browserSessionId, url);
    let result: { errorText?: string };
    try {
      result = await entry.host
        .cdp()
        .send<{ errorText?: string }>(
          'Page.navigate',
          { url },
          target.cdpSessionId,
        );
    } finally {
      if (this.inflightNavigations.get(browserSessionId) === url)
        this.inflightNavigations.delete(browserSessionId);
    }
    // The browser may have exited while the command was in flight.
    this.requireLive(browserSessionId, record.generation);
    record.url = url;
    // Station's own refusal, said as Station's — to the operator only: a
    // Project admin's history must not map which addresses are Station's.
    // Only in the operator's OWN session: the entry must never land in a
    // history a Project admin can read.
    const blockedByStation =
      result.errorText !== undefined &&
      options.actor.kind === 'operator' &&
      record.principalKey === 'operator' &&
      this.options.isStationAddress?.(url) === true;
    if (blockedByStation)
      this.record(record, 'navigation-blocked', options.actor, {
        url,
        detail: "blocked by Station: it is one of Station's own services",
      });
    else
      this.record(record, 'navigated', options.actor, {
        ...(result.errorText !== undefined ? { failed: true as const } : {}),
        url,
        ...(result.errorText ? { detail: result.errorText } : {}),
      });
    return {
      session: structuredClone(record),
      ...(result.errorText ? { errorText: result.errorText } : {}),
    };
  }

  async closeSession(
    browserSessionId: string,
    actor: BrowserSessionActor,
  ): Promise<BrowserSessionRecord> {
    const record = this.require(browserSessionId);
    if (record.state === 'closed') return structuredClone(record);
    const entry = this.hosts.get(this.keyOf(record));
    const target = entry?.targets.get(record.browserSessionId);
    record.state = 'closed';
    record.endReason = 'closed';
    this.record(record, 'closed', actor);
    if (entry && target) {
      entry.targets.delete(record.browserSessionId);
      await entry.host.closeTarget(target.targetId).catch(() => {});
      this.scheduleIdleShutdown(this.keyOf(record), entry);
    }
    return structuredClone(record);
  }

  /** Server stop: shut every browser down; live sessions become needs-reopen. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.starting.values()]);
    const entries = [...this.hosts.entries()];
    this.hosts.clear();
    const changed: BrowserSessionRecord[] = [];
    for (const record of this.sessions.values()) {
      if (record.state === 'live' || record.state === 'opening') {
        record.state = 'needs-reopen';
        record.endReason = 'server-stopped';
        this.append(record, 'server-stopped', SYSTEM, {
          generation: record.generation,
        });
        changed.push(record);
      }
    }
    this.persist();
    for (const record of changed) this.notify(record);
    await Promise.allSettled(
      entries.map(async ([, entry]) => {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        entry.offExit();
        await entry.host.shutdown();
      }),
    );
  }

  private keyOf(
    record: Pick<BrowserSessionRecord, 'projectId' | 'principalKey'>,
  ) {
    return `${record.projectId}\u001f${record.principalKey}`;
  }

  private profileOf(record: BrowserSessionRecord): BrowserProfile {
    return {
      projectId: record.projectId,
      principalKey: record.principalKey,
      reach: record.reach,
      key: this.keyOf(record),
      profileRef: record.profileRef,
    };
  }

  private async attach(record: BrowserSessionRecord): Promise<void> {
    const profile = this.profileOf(record);
    // Reserve BEFORE the first await so an idle shutdown cannot fire between
    // resolving the host and opening the target on it.
    this.reservations.set(
      profile.key,
      (this.reservations.get(profile.key) ?? 0) + 1,
    );
    let entry: HostEntry | undefined;
    let offEarlyDialogs = () => {};
    try {
      entry = await this.ensureHost(profile);
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = undefined;
      }
      const target = await entry.host.openTarget({
        profileDir: browserProfileDir(
          this.options.stationHome,
          record.profileRef,
        ),
        viewport: record.viewport,
      });
      if (record.state === 'closed') {
        // Closed while opening: nothing may run in a closed session.
        await entry.host.closeTarget(target.targetId).catch(() => {});
        return;
      }
      entry.targets.set(record.browserSessionId, target);
      // Dialogs are answered from the moment the page exists — before its
      // first navigation — until the live surface's producer takes over. A
      // page whose load handler calls alert() must not hold anything up.
      offEarlyDialogs = this.answerDialogsUntilLive(record, entry, target);
      try {
        if (record.url !== ABOUT_BLANK) {
          await entry.host
            .cdp()
            .send('Page.navigate', { url: record.url }, target.cdpSessionId);
        }
      } catch (error) {
        entry.targets.delete(record.browserSessionId);
        await entry.host.closeTarget(target.targetId).catch(() => {});
        throw error;
      }
      // The state may have changed while the navigation was in flight.
      if ((record.state as BrowserSessionState) === 'closed') {
        // closeSession already found and closed the registered target.
        if (entry.targets.get(record.browserSessionId) === target) {
          entry.targets.delete(record.browserSessionId);
          await entry.host.closeTarget(target.targetId).catch(() => {});
        }
        return;
      }
      record.generation = entry.generation;
      record.state = 'live';
      // Notifies observers synchronously: the producer registered for the
      // live session subscribes before the early answerer is removed below.
      this.touch(record);
    } finally {
      offEarlyDialogs();
      const left = (this.reservations.get(profile.key) ?? 1) - 1;
      if (left > 0) this.reservations.set(profile.key, left);
      else this.reservations.delete(profile.key);
      if (entry && this.hosts.get(profile.key) === entry)
        this.scheduleIdleShutdown(profile.key, entry);
    }
  }

  private answerDialogsUntilLive(
    record: BrowserSessionRecord,
    entry: HostEntry,
    target: BrowserTarget,
  ): () => void {
    try {
      const cdp = entry.host.cdp();
      return cdp.on('Page.javascriptDialogOpening', (raw, sessionId) => {
        if (sessionId !== target.cdpSessionId) return;
        const event = (raw ?? {}) as { type?: unknown; message?: unknown };
        const type = typeof event.type === 'string' ? event.type : 'unknown';
        const accepted = type === 'beforeunload';
        cdp
          .send(
            'Page.handleJavaScriptDialog',
            { accept: accepted },
            target.cdpSessionId,
          )
          .catch(() => {});
        this.appendDialog(record, {
          type,
          message:
            typeof event.message === 'string'
              ? event.message.slice(0, 300)
              : '',
          accepted,
        });
      });
    } catch {
      return () => {};
    }
  }

  private ensureHost(profile: BrowserProfile): Promise<HostEntry> {
    const existing = this.hosts.get(profile.key);
    if (existing) return Promise.resolve(existing);
    const pending = this.starting.get(profile.key);
    if (pending) return pending;
    const start = (async () => {
      const host = await this.hostResolver.resolve({
        projectId: profile.projectId,
        principalKey: profile.principalKey,
        hostId: LOCAL_BROWSER_HOST_ID,
      });
      const generation =
        Math.max(this.generations.get(profile.key) ?? 0, this.generationFloor) +
        1;
      this.generations.set(profile.key, generation);
      this.persist();
      const entry: HostEntry = {
        host,
        generation,
        targets: new Map(),
        offExit: () => {},
      };
      entry.offExit = host.onExit((reason) =>
        this.onHostExit(profile.key, entry, reason),
      );
      this.hosts.set(profile.key, entry);
      return entry;
    })();
    this.starting.set(profile.key, start);
    return start.finally(() => this.starting.delete(profile.key));
  }

  private onHostExit(key: string, entry: HostEntry, reason: string): void {
    if (this.hosts.get(key) !== entry) return;
    this.hosts.delete(key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    const changed: BrowserSessionRecord[] = [];
    for (const record of this.sessions.values()) {
      if (
        this.keyOf(record) === key &&
        record.generation === entry.generation &&
        (record.state === 'live' || record.state === 'opening')
      ) {
        record.state = 'needs-reopen';
        record.endReason = 'host-exited';
        this.append(record, 'host-exited', SYSTEM, {
          generation: record.generation,
          detail: reason,
        });
        changed.push(record);
      }
    }
    this.persist();
    for (const record of changed) this.notify(record);
  }

  private scheduleIdleShutdown(key: string, entry: HostEntry): void {
    const busy = () =>
      entry.targets.size > 0 || (this.reservations.get(key) ?? 0) > 0;
    if (busy() || entry.idleTimer) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (this.hosts.get(key) !== entry || busy()) return;
      this.hosts.delete(key);
      entry.offExit();
      void entry.host.shutdown().catch(() => {});
    }, this.options.idleShutdownMs ?? DEFAULT_BROWSER_IDLE_SHUTDOWN_MS);
    entry.idleTimer.unref?.();
  }

  private normalize(rawUrl: string): string {
    const decision = normalizeBrowserUrl(rawUrl);
    if (!decision.ok) {
      throw new BrowserSessionError(
        'url-not-allowed',
        'The URL is outside the Browser pane scope.',
        { urlRejection: decision.reason },
      );
    }
    return decision.url;
  }

  private require(browserSessionId: string): BrowserSessionRecord {
    const record = this.sessions.get(browserSessionId);
    if (!record) {
      throw new BrowserSessionError('not-found', 'No such browser session.');
    }
    return record;
  }

  private requireLive(
    browserSessionId: string,
    expectedGeneration: number | undefined,
  ): BrowserSessionRecord {
    const record = this.require(browserSessionId);
    if (
      expectedGeneration !== undefined &&
      expectedGeneration !== record.generation
    ) {
      throw new BrowserSessionError(
        'stale-generation',
        'The session reference is from an earlier browser generation.',
        { generation: record.generation },
      );
    }
    if (record.state !== 'live') {
      throw new BrowserSessionError(
        'not-live',
        `The session is ${record.state}.`,
      );
    }
    return record;
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new BrowserSessionError(
        'stopped',
        'The browser service has stopped.',
      );
    }
  }

  private touch(record: BrowserSessionRecord): void {
    record.updatedAt = this.now().toISOString();
    this.persist();
    this.notify(record);
  }

  private notify(record: BrowserSessionRecord): void {
    for (const listener of [...this.changeListeners]) {
      try {
        listener(structuredClone(record));
      } catch {
        // One observer's failure must not hide the change from the others.
      }
    }
  }

  /**
   * Append one action (bounded, counted) without persisting. Actor and
   * lifecycle entries and page-originated entries are bounded SEPARATELY:
   * a page flooding dialogs or navigations only ever evicts its own noise,
   * never what a person or an agent did (B1).
   */
  private append(
    record: BrowserSessionRecord,
    kind: BrowserSessionActionKind,
    actor: BrowserSessionActor,
    extra: {
      url?: string;
      generation?: number;
      detail?: string;
      failed?: true;
      /** False: the entry does not move `updatedAt` (refusals, M1). */
      touch?: boolean;
    } = {},
  ): BrowserSessionAction {
    const at = this.now().toISOString();
    record.history.total += 1;
    const entry: BrowserSessionAction = {
      seq: record.history.total,
      at,
      kind,
      actor: structuredClone(actor),
      ...(extra.url !== undefined ? { url: extra.url } : {}),
      generation: extra.generation ?? record.generation,
      ...(extra.detail !== undefined
        ? { detail: extra.detail.slice(0, 500) }
        : {}),
      ...(extra.failed ? { failed: true as const } : {}),
    };
    record.history.entries.push(entry);
    trimHistory(record.history);
    noteActivity(record, entry);
    if (extra.touch !== false) record.updatedAt = at;
    return entry;
  }

  private record(
    record: BrowserSessionRecord,
    kind: BrowserSessionActionKind,
    actor: BrowserSessionActor,
    extra?: {
      url?: string;
      generation?: number;
      detail?: string;
      failed?: true;
    },
  ): void {
    this.append(record, kind, actor, extra);
    this.persist();
    this.notify(record);
  }

  /**
   * A page-originated entry: folded into the previous one when the page
   * repeats itself within the fold window, written to disk on a debounce,
   * and not broadcast (it changes neither state nor generation). A page
   * can therefore neither flood the history nor block the event loop with
   * a synchronous write per dialog.
   */
  private recordPageNoise(
    record: BrowserSessionRecord,
    kind: BrowserSessionActionKind,
    extra: { url?: string; detail?: string; cause?: BrowserSessionActor },
  ): BrowserSessionAction {
    const now = this.now();
    const last = record.history.entries.at(-1);
    if (
      last &&
      last.kind === kind &&
      last.generation === record.generation &&
      now.getTime() - Date.parse(last.at) <= PAGE_NOISE_FOLD_MS
    ) {
      last.count = (last.count ?? 1) + 1;
      last.at = now.toISOString();
      if (extra.url !== undefined) last.url = extra.url;
      if (extra.detail !== undefined) last.detail = extra.detail.slice(0, 500);
      if (extra.cause !== undefined) last.cause = structuredClone(extra.cause);
      record.history.total += 1;
      record.updatedAt = last.at;
      this.persistSoon();
      return last;
    }
    const { cause, ...rest } = extra;
    const entry = this.append(record, kind, SYSTEM, rest);
    if (cause !== undefined) entry.cause = structuredClone(cause);
    this.persistSoon();
    return entry;
  }

  private persistSoon(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persist();
    }, PAGE_NOISE_PERSIST_MS);
    this.persistTimer.unref?.();
  }

  private load(): void {
    if (!existsSync(this.storePath)) return;
    let parsed: StoreShape;
    try {
      parsed = JSON.parse(readFileSync(this.storePath, 'utf8')) as StoreShape;
    } catch {
      // An unreadable store holds nothing live by definition. Keep the file for
      // inspection; the next write replaces it. Generations restart from the
      // wall clock so a surviving old reference can never match.
      this.generationFloor = Math.floor(this.now().getTime() / 1000);
      return;
    }
    if (parsed?.version !== STORE_VERSION) return;
    for (const [key, generation] of Object.entries(parsed.generations ?? {})) {
      if (typeof key === 'string' && Number.isInteger(generation))
        this.generations.set(key, generation);
    }
    const nowMs = this.now().getTime();
    for (const record of parsed.sessions ?? []) {
      if (!record || typeof record.browserSessionId !== 'string') continue;
      if (!isValidBrowserProjectId(record.projectId)) continue;
      if (
        typeof record.principalKey !== 'string' ||
        (record.reach !== 'operator' && record.reach !== 'project') ||
        typeof record.profileRef !== 'string'
      )
        continue;
      if (
        record.state === 'closed' &&
        nowMs - Date.parse(record.updatedAt) > CLOSED_RETENTION_MS
      )
        continue;
      // Records from before #90 D13 ran on this Station.
      if (typeof record.hostId !== 'string')
        record.hostId = LOCAL_BROWSER_HOST_ID;
      if (
        !record.history ||
        !Array.isArray(record.history.entries) ||
        !Number.isInteger(record.history.total)
      ) {
        record.history = { entries: [], total: 0 };
      }
      if (
        !record.activity ||
        typeof record.activity.agentDriven !== 'boolean'
      ) {
        record.activity = emptyActivity();
        for (const entry of record.history.entries) noteActivity(record, entry);
      }
      if (record.state === 'live' || record.state === 'opening') {
        // The process that held these died with the previous server.
        record.state = 'needs-reopen';
        record.endReason = 'server-restarted';
        this.append(record, 'server-restarted', SYSTEM, {
          generation: record.generation,
        });
      }
      this.sessions.set(record.browserSessionId, record);
    }
  }

  private persist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    const sessions = [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_STORED_SESSIONS);
    const store: StoreShape = {
      version: STORE_VERSION,
      generations: Object.fromEntries(this.generations),
      sessions,
    };
    try {
      mkdirSync(join(this.options.stationHome, 'browser'), {
        recursive: true,
        mode: 0o700,
      });
      const temp = `${this.storePath}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, {
        mode: 0o600,
      });
      renameSync(temp, this.storePath);
    } catch {
      // Persistence is advisory for restart display; the in-memory registry
      // stays authoritative for this process.
    }
  }
}

function isPageNoise(entry: BrowserSessionAction): boolean {
  return PAGE_NOISE_KINDS.has(entry.kind);
}

function isRefusal(entry: BrowserSessionAction): boolean {
  return entry.kind === 'agent-refused';
}

/** Enforce the two bounds, evicting the oldest entry of the class over. */
function trimHistory(history: BrowserSessionHistory): void {
  let noise = history.entries.filter(isPageNoise).length;
  let refusals = history.entries.filter(isRefusal).length;
  let actions = history.entries.length - noise - refusals;
  if (
    noise <= BROWSER_SESSION_PAGE_NOISE_LIMIT &&
    refusals <= BROWSER_SESSION_REFUSAL_LIMIT &&
    actions <= BROWSER_SESSION_HISTORY_LIMIT
  )
    return;
  history.entries = history.entries.filter((entry) => {
    if (isPageNoise(entry)) {
      if (noise > BROWSER_SESSION_PAGE_NOISE_LIMIT) {
        noise -= 1;
        return false;
      }
    } else if (isRefusal(entry)) {
      if (refusals > BROWSER_SESSION_REFUSAL_LIMIT) {
        refusals -= 1;
        return false;
      }
    } else if (actions > BROWSER_SESSION_HISTORY_LIMIT) {
      actions -= 1;
      return false;
    }
    return true;
  });
}

/** Keep the derived "who drove it" facts current as actions arrive. */
function noteActivity(
  record: BrowserSessionRecord,
  entry: Pick<BrowserSessionAction, 'actor' | 'kind' | 'at' | 'failed'>,
): void {
  const { actor, kind } = entry;
  if (actor.kind === 'system' || NON_DRIVING_KINDS.has(kind)) return;
  record.activity.lastDriver = structuredClone(actor);
  if (actor.kind === 'agent') record.activity.agentDriven = true;
  if (actor.kind === 'agent' && AGENT_INPUT_KINDS.has(kind) && !entry.failed)
    record.activity.lastAgentInputAt = entry.at;
}

function summarize(record: BrowserSessionRecord): BrowserSessionSummary {
  const { history, ...rest } = structuredClone(record);
  const entries = history.entries
    .slice(-BROWSER_SESSION_SUMMARY_ACTIONS)
    .map((entry) =>
      entry.url === undefined
        ? entry
        : { ...entry, url: redactBrowserUrl(entry.url) },
    );
  return {
    ...rest,
    url: redactBrowserUrl(rest.url),
    history: {
      entries,
      total: history.total,
      omittedFromSummary: history.entries.length - entries.length,
    },
  };
}

async function applyViewport(
  cdp: CdpTransport,
  session: string,
  viewport: BrowserViewport,
): Promise<void> {
  const mobile = viewport.mobile === true;
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      mobile,
    },
    session,
  );
  await cdp.send(
    'Emulation.setTouchEmulationEnabled',
    { enabled: mobile },
    session,
  );
}
