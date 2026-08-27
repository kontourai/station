import {
  parseWorkspacePaneDescriptor,
  WORKSPACE_PANE_CONTRACT_VERSION,
} from './workspace-pane.js';

/**
 * Host-neutral state for a local Browser Workspace Pane. This contract only
 * describes a validated local URL and renderer outcome; it never discovers a
 * server, proxies traffic, carries credentials, or grants browser authority.
 */

export const WORKSPACE_BROWSER_PREVIEW_CONTRACT_VERSION = '1.0' as const;
export const WORKSPACE_BROWSER_PREVIEW_PANE_VERSION = '1.0' as const;
export const WORKSPACE_BROWSER_PREVIEW_MAX_URL_LENGTH = 2_048;
export const WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR_ID =
  'pane:builtin:workspace-preview:browser-preview';
export const WORKSPACE_BROWSER_PREVIEW_PANE_RENDERER_ID =
  'renderer:builtin:builtin-component:workspace-browser-preview';
export const WORKSPACE_BROWSER_PREVIEW_PANE_RENDERER_NAME =
  'workspace-browser-preview';
export const WORKSPACE_BROWSER_PREVIEW_PANE_SOURCE_ID =
  'builtin:workspace-browser-preview';

const parsedWorkspaceBrowserPreviewPaneDescriptor =
  parseWorkspacePaneDescriptor({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    id: WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR_ID,
    name: 'Browser Preview',
    description: 'Open a validated local browser preview for a workspace.',
    rendererId: WORKSPACE_BROWSER_PREVIEW_PANE_RENDERER_ID,
    renderer: {
      kind: 'builtin-component',
      name: WORKSPACE_BROWSER_PREVIEW_PANE_RENDERER_NAME,
    },
    placement: {
      supportedRegions: ['primary', 'secondary', 'standalone'],
      preferredRegion: 'secondary',
    },
    modes: [
      { id: 'default', contextRequirement: { project: true, source: true } },
    ],
    provenance: { origin: 'builtin' },
    lifecycle: { stage: 'preview' },
  });

if (!parsedWorkspaceBrowserPreviewPaneDescriptor) {
  throw new Error('Canonical Browser Preview pane descriptor must be valid');
}

/** One code-owned descriptor shared by catalog and renderer admission. */
export const WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR =
  parsedWorkspaceBrowserPreviewPaneDescriptor;

export type WorkspaceBrowserPreviewStatus =
  | 'external-action-ready'
  | 'loading'
  | 'rendering-unverified'
  | 'unavailable';

/** History controls are intentionally absent from this first local preview seam. */
export type WorkspaceBrowserPreviewHistoryCapability = 'unavailable';

export type WorkspaceBrowserPreviewViewportPreference =
  | 'desktop'
  | 'mobile'
  | 'responsive';

/**
 * Exact identities supplied by a later owning workspace binding. These are
 * descriptive only: their presence neither authorizes a URL nor discovers one.
 */
export interface WorkspaceBrowserPreviewIdentity {
  projectId?: string;
  taskId?: string;
  environmentId?: string;
}

export interface WorkspaceBrowserPreviewState {
  contractVersion: typeof WORKSPACE_BROWSER_PREVIEW_CONTRACT_VERSION;
  /** The normalized local URL the user or a future owner requested. */
  requestedUrl: string;
  /** The normalized local URL currently mounted by a renderer, if any. */
  currentUrl: string;
  status: WorkspaceBrowserPreviewStatus;
  /** Explicitly unavailable until a separately owned history implementation exists. */
  historyCapability: WorkspaceBrowserPreviewHistoryCapability;
  viewportPreference: WorkspaceBrowserPreviewViewportPreference;
  /** Canonical UTC ISO-8601 timestamp supplied by the state owner. */
  updatedAt: string;
  identity?: WorkspaceBrowserPreviewIdentity;
}

/**
 * Persisted metadata for one Browser Preview occurrence. Renderer outcome and
 * frame lifecycle are intentionally excluded: reopening a pane never treats a
 * prior load event as evidence that the current renderer is healthy.
 */
export interface WorkspaceBrowserPreviewPaneState {
  version: typeof WORKSPACE_BROWSER_PREVIEW_PANE_VERSION;
  projectId: string;
  requestedUrl: string;
  viewportPreference: WorkspaceBrowserPreviewViewportPreference;
  updatedAt: string;
}

function snapshotPlainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        return null;
      }
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return snapshot;
  } catch {
    return null;
  }
}

function isLoopbackIpv4(hostname: string): boolean {
  const segments = hostname.split('.');
  if (segments.length !== 4) return false;
  return segments.every((segment, index) => {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(segment)) return false;
    const number = Number(segment);
    return number >= 0 && number <= 255 && (index !== 0 || number === 127);
  });
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' || hostname === '[::1]' || isLoopbackIpv4(hostname)
  );
}

/**
 * Produces the one URL form this preview seam can render: an absolute HTTP(S)
 * URL addressed directly to the local loopback interface. The caller must use
 * the result as-is; this helper deliberately has no proxy, header, or auth
 * behavior to make a remote destination appear local.
 */
export function normalizeLocalBrowserPreviewUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('A local browser preview URL is required');
  }
  if (value.length > WORKSPACE_BROWSER_PREVIEW_MAX_URL_LENGTH) {
    throw new Error('Local browser preview URL exceeds the bounded length');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('A local browser preview URL must be absolute');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      'Only http and https local browser preview URLs are allowed',
    );
  }
  if (url.username || url.password) {
    throw new Error('Local browser preview URLs cannot include credentials');
  }
  if (url.hash) {
    throw new Error('Local browser preview URLs cannot include fragments');
  }
  if (!isLoopbackHostname(url.hostname)) {
    throw new Error(
      'Local browser preview URLs must use an exact loopback host',
    );
  }

  return url.toString();
}

function isIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 192 &&
    value === value.trim()
  );
}

function parseCanonicalUpdatedAt(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('updatedAt must be a canonical UTC ISO-8601 timestamp');
  }
  const updatedAt = new Date(value);
  if (Number.isNaN(updatedAt.valueOf()) || updatedAt.toISOString() !== value) {
    throw new Error('updatedAt must be a canonical UTC ISO-8601 timestamp');
  }
  return value;
}

/** Strictly parses the bounded, data-only Browser Preview pane state. */
export function parseWorkspaceBrowserPreviewPaneState(
  value: unknown,
): WorkspaceBrowserPreviewPaneState | null {
  const record = snapshotPlainRecord(value);
  if (!record) return null;
  const allowed = new Set([
    'version',
    'projectId',
    'requestedUrl',
    'viewportPreference',
    'updatedAt',
  ]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    record.version !== WORKSPACE_BROWSER_PREVIEW_PANE_VERSION ||
    !isIdentity(record.projectId) ||
    (record.viewportPreference !== 'desktop' &&
      record.viewportPreference !== 'mobile' &&
      record.viewportPreference !== 'responsive')
  ) {
    return null;
  }
  try {
    return {
      version: WORKSPACE_BROWSER_PREVIEW_PANE_VERSION,
      projectId: record.projectId,
      requestedUrl: normalizeLocalBrowserPreviewUrl(record.requestedUrl),
      viewportPreference: record.viewportPreference,
      updatedAt: parseCanonicalUpdatedAt(record.updatedAt),
    };
  } catch {
    return null;
  }
}

function parseIdentity(value: unknown): WorkspaceBrowserPreviewIdentity {
  const record = snapshotPlainRecord(value);
  if (!record) {
    throw new Error('identity must be an object');
  }
  const allowed = new Set(['projectId', 'taskId', 'environmentId']);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error('identity contains an unknown field');
  }

  const identity: WorkspaceBrowserPreviewIdentity = {};
  for (const key of allowed) {
    const candidate = record[key];
    if (candidate === undefined) continue;
    if (
      typeof candidate !== 'string' ||
      !candidate.trim() ||
      candidate !== candidate.trim()
    ) {
      throw new Error(`identity.${key} must be a non-empty trimmed string`);
    }
    identity[key as keyof WorkspaceBrowserPreviewIdentity] = candidate;
  }
  if (Object.keys(identity).length === 0) {
    throw new Error('identity must name at least one exact owner identity');
  }
  return identity;
}

/** Parse persisted or transport state without granting renderer execution. */
export function parseWorkspaceBrowserPreviewState(
  value: unknown,
): WorkspaceBrowserPreviewState {
  const record = snapshotPlainRecord(value);
  if (!record) {
    throw new Error('browser preview state must be an object');
  }
  const allowed = new Set([
    'contractVersion',
    'requestedUrl',
    'currentUrl',
    'status',
    'historyCapability',
    'viewportPreference',
    'updatedAt',
    'identity',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error('browser preview state contains an unknown field');
  }
  if (record.contractVersion !== WORKSPACE_BROWSER_PREVIEW_CONTRACT_VERSION) {
    throw new Error('Unsupported browser preview contract version');
  }
  if (
    record.status !== 'loading' &&
    record.status !== 'rendering-unverified' &&
    record.status !== 'unavailable'
  ) {
    throw new Error('Invalid browser preview status');
  }
  if (record.historyCapability !== 'unavailable') {
    throw new Error('Browser preview history must be explicitly unavailable');
  }
  if (
    record.viewportPreference !== 'desktop' &&
    record.viewportPreference !== 'mobile' &&
    record.viewportPreference !== 'responsive'
  ) {
    throw new Error('Invalid browser preview viewport preference');
  }
  const updatedAt = parseCanonicalUpdatedAt(record.updatedAt);

  return {
    contractVersion: WORKSPACE_BROWSER_PREVIEW_CONTRACT_VERSION,
    requestedUrl: normalizeLocalBrowserPreviewUrl(record.requestedUrl),
    currentUrl: normalizeLocalBrowserPreviewUrl(record.currentUrl),
    status: record.status,
    historyCapability: 'unavailable',
    viewportPreference: record.viewportPreference,
    updatedAt,
    ...(record.identity === undefined
      ? {}
      : { identity: parseIdentity(record.identity) }),
  };
}
