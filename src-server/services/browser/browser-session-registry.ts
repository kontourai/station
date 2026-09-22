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
 */
import { randomUUID } from 'node:crypto';
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

export interface BrowserSessionRecord {
  browserSessionId: string;
  projectId: string;
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
export const BROWSER_SESSION_SUMMARY_ACTIONS = 5;
const SYSTEM: BrowserSessionActor = { kind: 'system' };

export type BrowserSessionErrorCode =
  | 'url-not-allowed'
  | 'invalid-project'
  | 'invalid-viewport'
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

export const DEFAULT_BROWSER_VIEWPORT: BrowserViewport = {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
};

export const DEFAULT_BROWSER_IDLE_SHUTDOWN_MS = 60_000;

const STORE_VERSION = 1;
const MAX_STORED_SESSIONS = 500;
const CLOSED_RETENTION_MS = 24 * 60 * 60 * 1000;
const PROJECT_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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

/** Home-relative, always `/`-separated so the persisted record is portable. */
export function browserProfileRef(projectId: string): string {
  return posix.join('projects', projectId, 'browser', 'profile');
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
  createHost(projectId: string): BrowserHost | Promise<BrowserHost>;
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
        const entries = history.entries.slice(-BROWSER_SESSION_SUMMARY_ACTIONS);
        return {
          ...rest,
          history: {
            entries,
            total: history.total,
            omittedFromSummary: history.entries.length - entries.length,
          },
        };
      });
  }

  /** Whether a Project currently has a running browser (diagnostics/tests). */
  hasRunningHost(projectId: string): boolean {
    return this.hosts.has(projectId);
  }

  async createSession(input: {
    projectId: string;
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
      ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
      url,
      viewport: { ...viewport },
      generation: 0,
      hostKind: this.hostKind,
      profileRef: browserProfileRef(input.projectId),
      state: 'opening',
      createdAt: at,
      updatedAt: at,
      history: { entries: [], total: 0 },
    };
    this.sessions.set(record.browserSessionId, record);
    try {
      await this.attach(record);
    } catch (error) {
      this.sessions.delete(record.browserSessionId);
      this.persist();
      throw error;
    }
    this.record(record, 'created', input.actor, { url });
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
    const entry = this.hosts.get(record.projectId);
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
    const entry = this.hosts.get(record.projectId);
    const target = entry?.targets.get(record.browserSessionId);
    record.state = 'closed';
    record.endReason = 'closed';
    this.record(record, 'closed', actor);
    if (entry && target) {
      entry.targets.delete(record.browserSessionId);
      await entry.host.closeTarget(target.targetId).catch(() => {});
      this.scheduleIdleShutdown(record.projectId, entry);
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

  private async attach(record: BrowserSessionRecord): Promise<void> {
    const entry = await this.ensureHost(record.projectId);
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
      this.scheduleIdleShutdown(record.projectId, entry);
      throw error;
    }
    record.generation = entry.generation;
    record.state = 'live';
    this.touch(record);
  }

  private ensureHost(projectId: string): Promise<HostEntry> {
    const existing = this.hosts.get(projectId);
    if (existing) return Promise.resolve(existing);
    const pending = this.starting.get(projectId);
    if (pending) return pending;
    const start = (async () => {
      const host = await this.options.createHost(projectId);
      const generation =
        Math.max(this.generations.get(projectId) ?? 0, this.generationFloor) +
        1;
      this.generations.set(projectId, generation);
      this.persist();
      const entry: HostEntry = {
        host,
        generation,
        targets: new Map(),
        offExit: () => {},
      };
      entry.offExit = host.onExit((reason) =>
        this.onHostExit(projectId, entry, reason),
      );
      this.hosts.set(projectId, entry);
      return entry;
    })();
    this.starting.set(projectId, start);
    return start.finally(() => this.starting.delete(projectId));
  }

  private onHostExit(
    projectId: string,
    entry: HostEntry,
    reason: string,
  ): void {
    if (this.hosts.get(projectId) !== entry) return;
    this.hosts.delete(projectId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    for (const record of this.sessions.values()) {
      if (
        record.projectId === projectId &&
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

  private scheduleIdleShutdown(projectId: string, entry: HostEntry): void {
    if (entry.targets.size > 0 || entry.idleTimer) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (this.hosts.get(projectId) !== entry || entry.targets.size > 0) return;
      this.hosts.delete(projectId);
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
    for (const [projectId, generation] of Object.entries(
      parsed.generations ?? {},
    )) {
      if (isValidBrowserProjectId(projectId) && Number.isInteger(generation))
        this.generations.set(projectId, generation);
    }
    const nowMs = this.now().getTime();
    for (const record of parsed.sessions ?? []) {
      if (!record || typeof record.browserSessionId !== 'string') continue;
      if (!isValidBrowserProjectId(record.projectId)) continue;
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
