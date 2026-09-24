/**
 * Browser pane v2 (#90): the per-device pane state, its migration from the
 * v1 Browser Preview state, and the wire views the pane reads from
 * `/api/browser/*`.
 *
 * The pane no longer owns a URL. A browser session is SERVER-owned (its URL,
 * viewport, generation, history); pane state v2 persists only which session
 * this pane shows, on this device. The descriptor and registry slot stay
 * those of `workspace-browser-preview.ts`, which still owns the v1 shape the
 * migration reads.
 */
import {
  parseWorkspaceBrowserPreviewPaneState,
  WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR,
  WORKSPACE_BROWSER_PREVIEW_PANE_SOURCE_ID,
  type WorkspaceBrowserPreviewViewportPreference,
} from './workspace-browser-preview.js';
import {
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneInstance,
} from './workspace-pane.js';

export const WORKSPACE_BROWSER_PANE_STATE_VERSION = '2.0' as const;

/**
 * The deployment capability the Browser pane requires: the answering Station
 * mounts `/api/browser` (personal hosts only). Derived by the SERVER from its
 * own composition; a client cannot observe it and never overrides it.
 */
export const BROWSER_PANE_DEPLOYMENT_CAPABILITY = 'browser-pane';

/** `bs_` + a UUID, as the server mints them. */
export const BROWSER_SESSION_ID_PATTERN = /^bs_[0-9a-f-]{36}$/;

/**
 * The conversation a browser session belongs to (`threadId`): what the pane
 * routes accept and what an agent's verified conversation must match to be
 * recorded, so the two can never disagree about which ids a chat can float.
 */
export const BROWSER_THREAD_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export interface WorkspaceBrowserPaneState {
  version: typeof WORKSPACE_BROWSER_PANE_STATE_VERSION;
  projectId: string;
  browserSessionId: string;
  updatedAt: string;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const snapshot: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    )
      return null;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function isProjectId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 192 &&
    value === value.trim()
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

/** Strict v2 parse: exactly the four fields, each well-formed. */
export function parseWorkspaceBrowserPaneState(
  value: unknown,
): WorkspaceBrowserPaneState | null {
  const record = plainRecord(value);
  if (!record) return null;
  const allowed = ['version', 'projectId', 'browserSessionId', 'updatedAt'];
  if (Object.keys(record).some((key) => !allowed.includes(key))) return null;
  if (
    record.version !== WORKSPACE_BROWSER_PANE_STATE_VERSION ||
    !isProjectId(record.projectId) ||
    typeof record.browserSessionId !== 'string' ||
    !BROWSER_SESSION_ID_PATTERN.test(record.browserSessionId) ||
    !isCanonicalTimestamp(record.updatedAt)
  )
    return null;
  return {
    version: WORKSPACE_BROWSER_PANE_STATE_VERSION,
    projectId: record.projectId,
    browserSessionId: record.browserSessionId,
    updatedAt: record.updatedAt,
  };
}

/**
 * A v1 record the pane must migrate on first mount: open (or restore) a
 * server session for `requestedUrl`, then persist v2 in its place.
 */
export interface WorkspaceBrowserPaneMigration {
  projectId: string;
  requestedUrl: string;
  viewportPreference: WorkspaceBrowserPreviewViewportPreference;
}

export type StoredWorkspaceBrowserPaneState =
  | { version: '2.0'; state: WorkspaceBrowserPaneState }
  | { version: '1.0'; migration: WorkspaceBrowserPaneMigration };

/** Read a stored pane record of either version; null when it is neither. */
export function parseStoredWorkspaceBrowserPaneState(
  value: unknown,
): StoredWorkspaceBrowserPaneState | null {
  const v2 = parseWorkspaceBrowserPaneState(value);
  if (v2) return { version: '2.0', state: v2 };
  const v1 = parseWorkspaceBrowserPreviewPaneState(value);
  if (!v1) return null;
  return {
    version: '1.0',
    migration: {
      projectId: v1.projectId,
      requestedUrl: v1.requestedUrl,
      viewportPreference: v1.viewportPreference,
    },
  };
}

/** The v2 record that replaces a migrated v1 one. */
export function migrateWorkspaceBrowserPaneState(
  migration: WorkspaceBrowserPaneMigration,
  browserSessionId: string,
  updatedAt: string,
): WorkspaceBrowserPaneState | null {
  return parseWorkspaceBrowserPaneState({
    version: WORKSPACE_BROWSER_PANE_STATE_VERSION,
    projectId: migration.projectId,
    browserSessionId,
    updatedAt,
  });
}

/**
 * The Project's catalogue occurrence of the Browser pane: what the Add-pane
 * grid opens. Its identity is stable per Project (so the grid can say it is
 * already open) and has the same shape a launcher-minted pane has. It starts
 * with no stored state; the pane asks for a page and persists v2 once it
 * attaches to a session. The nonce is a digest of the Project id, not a
 * secret: pane identities are opaque, not authority.
 */
export function workspaceBrowserPaneCatalogInstance(
  projectId: string,
): WorkspacePaneInstance | null {
  if (!isProjectId(projectId)) return null;
  let hex = '';
  for (let round = 0; round < 4; round += 1) {
    // FNV-1a, re-seeded per round, over the Project id.
    let hash = (0x811c9dc5 ^ (round * 0x9e3779b1)) >>> 0;
    for (let index = 0; index < projectId.length; index += 1) {
      hash ^= projectId.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hex += hash.toString(16).padStart(8, '0');
  }
  const identity = `browser-preview:${hex}`;
  return parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR.id,
    instanceId: identity,
    stateKey: identity,
    boundContext: {
      projectId,
      sourceId: WORKSPACE_BROWSER_PREVIEW_PANE_SOURCE_ID,
    },
  });
}

// ---------------------------------------------------------------------------
// Wire views (`/api/browser/*` responses the pane reads)
// ---------------------------------------------------------------------------

export type BrowserSessionStateView =
  | 'opening'
  | 'live'
  | 'closed'
  | 'needs-reopen';

export type BrowserSessionActorView =
  | { kind: 'operator' }
  | { kind: 'project-admin'; principalId: string }
  | { kind: 'agent'; principalId?: string; sessionId: string }
  | { kind: 'system' };

export interface BrowserSessionActionView {
  seq: number;
  at: string;
  kind: string;
  actor: BrowserSessionActorView;
  url?: string;
  generation?: number;
  detail?: string;
  /** Repeated page-originated entries folded into this one. */
  count?: number;
  /** For `link-followed`: whose input the page's navigation followed. */
  cause?: BrowserSessionActorView;
}

/** Derived by the server over the session's whole history. */
export interface BrowserSessionActivityView {
  lastDriver?: BrowserSessionActorView;
  /** Server time of an agent's latest successful input or navigation. */
  lastAgentInputAt?: string;
  agentDriven: boolean;
  lastDialog?: {
    seq: number;
    at: string;
    type: string;
    message: string;
    accepted: boolean;
    count: number;
  };
}

export interface BrowserViewportView {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile?: boolean;
}

export interface BrowserSessionView {
  browserSessionId: string;
  projectId: string;
  projectSlug: string;
  principalKey: string;
  reach: 'operator' | 'project';
  threadId?: string;
  url: string;
  viewport: BrowserViewportView;
  generation: number;
  /** Which Station runs the browser (#90 D13); `local` today. */
  hostId?: string;
  state: BrowserSessionStateView;
  endReason?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * The server's clock when it sent this view. With `activity.lastAgentInputAt`
   * (same clock) it gives the input's age without comparing server time to
   * the client's.
   */
  serverNow?: string;
  history: {
    entries: BrowserSessionActionView[];
    total: number;
    omittedFromSummary?: number;
  };
  activity: BrowserSessionActivityView;
  /** Present only while the session is live and streaming is wired. */
  surfaceId?: string;
}

export interface BrowserPaneAccessView {
  projectId: string;
  role: 'operator' | 'project-admin';
  /** The profile the caller's own sessions run in (D7). */
  principalKey?: string;
  operator: boolean;
  browser: 'ready' | 'not-ready';
}

export type BrowserAcquisitionView =
  | { state: 'found-system'; browser: string }
  | { state: 'downloaded'; version: string }
  | { state: 'needs-consent'; version: string; downloadBytes: number }
  | {
      state: 'downloading';
      version: string;
      receivedBytes: number;
      totalBytes: number;
    }
  | { state: 'failed'; reason: string; detail: string; retryable: boolean };

export interface BrowserLocalTargetView {
  id: string;
  host: string;
  port: number;
  label: string;
  addedBy: string;
  addedAt: string;
}

export interface BrowserLocalTargetSuggestionView {
  host: string;
  port: number;
  label: string;
  pid: number | null;
  processName: string | null;
  /** Already masked by the server: secret-looking arguments are hidden. */
  commandLine: string | null;
  cwd: string;
  selected: false;
  warnings: string[];
}

export type BrowserLocalTargetSuggestionsView =
  | { state: 'ok'; suggestions: BrowserLocalTargetSuggestionView[] }
  | { state: 'unavailable'; reason: string };

/** Why the server refused a URL (`detail.urlRejection`). */
export type BrowserUrlRejectionView =
  | 'empty'
  | 'too-long'
  | 'malformed'
  | 'unsupported-scheme'
  | 'credentials';
