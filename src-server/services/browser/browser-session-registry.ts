/**
 * Server-owned Browser sessions (#90, design brief "Server-owned session").
 *
 * - One browser process per Project profile
 *   (`<home>/projects/<slug>/browser/profile`), holding any number of targets.
 * - Each launch of a Project's browser gets the next GENERATION number. The
 *   counter is persisted and only ever grows, across crashes and restarts, so
 *   a reference carrying an older generation is detectably stale.
 * - When the browser exits underneath its sessions they become
 *   `needs-reopen`; they are never silently re-attached to a new process.
 * - When a Project's last live session closes, its browser is shut down after
 *   an idle delay.
 * - Server stop shuts every browser down. Records persist, but a restart
 *   loads live sessions as `needs-reopen`: nothing comes back "live" without a
 *   browser behind it.
 * - Every session carries an append-only, bounded action history (D6): an
 *   agent may drive a session nobody is watching, so what happened in it must
 *   always be discoverable. Truncation is counted, never silent.
 * - Profiles are per (canonical Project ID, principal), never per slug (D7):
 *   the operator's logins are never visible to a Project admin's session, a
 *   slug rename keeps the profile, and a reused slug inherits nothing. The
 *   profile also fixes the network reach its browser's egress proxy enforces.
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
import type {
  BrowserHost,
  BrowserHostKind,
  BrowserTarget,
  BrowserViewport,
} from './browser-host.js';
import {
  ABOUT_BLANK,
  type BrowserUrlRejection,
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
  | 'server-restarted';

export interface BrowserSessionAction {
  seq: number;
  at: string;
  kind: BrowserSessionActionKind;
  actor: BrowserSessionActor;
  url?: string;
  generation?: number;
  detail?: string;
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
  /** Profile directory relative to the Station home. */
  profileRef: string;
  state: BrowserSessionState;
  endReason?: BrowserSessionEndReason;
  createdAt: string;
  updatedAt: string;
  history: BrowserSessionHistory;
}

/** List-view projection: the record with only the latest few actions. */
export interface BrowserSessionSummary
  extends Omit<BrowserSessionRecord, 'history'> {
  history: BrowserSessionHistory & { omittedFromSummary: number };
}

export const BROWSER_SESSION_HISTORY_LIMIT = 200;
const BROWSER_SESSION_SUMMARY_ACTIONS = 5;
const SYSTEM: BrowserSessionActor = { kind: 'system' };

export type BrowserSessionErrorCode =
  | 'url-not-allowed'
  | 'invalid-project'
  | 'invalid-viewport'
  | 'invalid-actor'
  | 'not-found'
  | 'not-live'
  | 'stale-generation'
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

const STORE_VERSION = 2;
const MAX_STORED_SESSIONS = 500;
const CLOSED_RETENTION_MS = 24 * 60 * 60 * 1000;
const PROJECT_SLUG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isValidBrowserViewport(
  value: unknown,
): value is BrowserViewport {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const dimension = (n: unknown) =>
    typeof n === 'number' && Number.isInteger(n) && n >= 100 && n <= 4096;
  return (
    dimension(v.width) &&
    dimension(v.height) &&
    typeof v.deviceScaleFactor === 'number' &&
    Number.isFinite(v.deviceScaleFactor) &&
    v.deviceScaleFactor >= 0.5 &&
    v.deviceScaleFactor <= 4
  );
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
  /** One new host per launch; the registry never reuses an exited host. */
  createHost(profile: BrowserProfile): BrowserHost | Promise<BrowserHost>;
  idleShutdownMs?: number;
  now?: () => Date;
  newId?: () => string;
}

interface HostEntry {
  host: BrowserHost;
  generation: number;
  targets: Map<string, BrowserTarget>;
  idleTimer?: NodeJS.Timeout;
  offExit: () => void;
}

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
  private stopped = false;
  /** Raised above every stored value when the store was unreadable. */
  private generationFloor = 0;
  private readonly storePath: string;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly hostKind: BrowserHostKind;

  constructor(private readonly options: BrowserSessionRegistryOptions) {
    this.storePath = join(options.stationHome, 'browser', 'sessions.json');
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => `bs_${randomUUID()}`);
    this.hostKind = options.hostKind ?? 'server-chromium';
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
      .map((record) => {
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
      });
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
    actor: BrowserSessionActor;
  }): Promise<BrowserSessionRecord> {
    this.assertRunning();
    if (!isValidBrowserProjectId(input.projectId)) {
      throw new BrowserSessionError(
        'invalid-project',
        'The Project id is not valid.',
      );
    }
    const profile = browserProfileFor(input.projectId, input.actor);
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
      profileRef: profile.profileRef,
      state: 'opening',
      createdAt: at,
      updatedAt: at,
      history: { entries: [], total: 0 },
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
    const result = await entry.host
      .cdp()
      .send<{ errorText?: string }>(
        'Page.navigate',
        { url },
        target.cdpSessionId,
      );
    // The browser may have exited while the command was in flight.
    this.requireLive(browserSessionId, record.generation);
    record.url = url;
    this.record(record, 'navigated', options.actor, {
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
    for (const record of this.sessions.values()) {
      if (record.state === 'live' || record.state === 'opening') {
        record.state = 'needs-reopen';
        record.endReason = 'server-stopped';
        this.append(record, 'server-stopped', SYSTEM, {
          generation: record.generation,
        });
      }
    }
    this.persist();
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
      this.touch(record);
    } finally {
      const left = (this.reservations.get(profile.key) ?? 1) - 1;
      if (left > 0) this.reservations.set(profile.key, left);
      else this.reservations.delete(profile.key);
      if (entry && this.hosts.get(profile.key) === entry)
        this.scheduleIdleShutdown(profile.key, entry);
    }
  }

  private ensureHost(profile: BrowserProfile): Promise<HostEntry> {
    const existing = this.hosts.get(profile.key);
    if (existing) return Promise.resolve(existing);
    const pending = this.starting.get(profile.key);
    if (pending) return pending;
    const start = (async () => {
      const host = await this.options.createHost(profile);
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
      }
    }
    this.persist();
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
  }

  /** Append one action (bounded, counted) without persisting. */
  private append(
    record: BrowserSessionRecord,
    kind: BrowserSessionActionKind,
    actor: BrowserSessionActor,
    extra: { url?: string; generation?: number; detail?: string } = {},
  ): void {
    const at = this.now().toISOString();
    record.history.total += 1;
    record.history.entries.push({
      seq: record.history.total,
      at,
      kind,
      actor: structuredClone(actor),
      ...(extra.url !== undefined ? { url: extra.url } : {}),
      generation: extra.generation ?? record.generation,
      ...(extra.detail !== undefined
        ? { detail: extra.detail.slice(0, 500) }
        : {}),
    });
    if (record.history.entries.length > BROWSER_SESSION_HISTORY_LIMIT) {
      record.history.entries.splice(
        0,
        record.history.entries.length - BROWSER_SESSION_HISTORY_LIMIT,
      );
    }
    record.updatedAt = at;
  }

  private record(
    record: BrowserSessionRecord,
    kind: BrowserSessionActionKind,
    actor: BrowserSessionActor,
    extra?: { url?: string; generation?: number; detail?: string },
  ): void {
    this.append(record, kind, actor, extra);
    this.persist();
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
      if (
        !record.history ||
        !Array.isArray(record.history.entries) ||
        !Number.isInteger(record.history.total)
      ) {
        record.history = { entries: [], total: 0 };
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
