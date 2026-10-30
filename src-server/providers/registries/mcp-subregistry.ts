/**
 * An MCP subregistry in the official MCP Registry API v0.1 shape
 * (`GET /v0.1/servers`, server.json schemas 2025-09-29 and 2025-12-11) as a
 * catalogue source: download it with byte, page, server and time bounds,
 * refuse it whole when any bound is passed or the document is malformed,
 * refuse single entries with every reason, keep the last good copy on disk
 * and serve it as stale when the network is unavailable. Nothing here
 * connects to, launches or installs a server; mapping entries to integration
 * definitions is `mcp-subregistry-provider.ts`.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasUnsafeTextChar } from '@kontourai/station-contracts/acp';
import type {
  RegistryMcpAuthMode,
  RegistryMcpSourceStatus,
} from '@kontourai/station-contracts/catalog';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger({ name: 'mcp-subregistry' });

/** The extension namespace Station's own curation is written under. */
export const STATION_CURATION_META_KEY = 'ai.kontour.station/curation';
const OFFICIAL_META_KEY = 'io.modelcontextprotocol.registry/official';

const SUPPORTED_SERVER_SCHEMAS: ReadonlySet<string> = new Set([
  'https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json',
  'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
]);

/**
 * A subregistry is a selection, not the whole public feed: these refuse an
 * index an order of magnitude past a useful curated list. The official
 * registry's complete feed is refused by design; point a source at a
 * subregistry or a narrowed query instead.
 */
export interface McpSubregistryLimits {
  /** Bytes per page, counted as they arrive. */
  maxBytes: number;
  maxPages: number;
  /** Server records across all pages, before version selection. */
  maxServers: number;
  /** Whole refresh, all pages. */
  fetchTimeoutMs: number;
  refreshAfterMs: number;
  retryAfterFailureMs: number;
  minRefreshIntervalMs: number;
}

export const MCP_SUBREGISTRY_LIMITS: Readonly<McpSubregistryLimits> = {
  maxBytes: 1024 * 1024,
  maxPages: 10,
  maxServers: 500,
  fetchTimeoutMs: 15_000,
  refreshAfterMs: 24 * 60 * 60 * 1000,
  retryAfterFailureMs: 15 * 60 * 1000,
  minRefreshIntervalMs: 30 * 1000,
};

const NAME_PATTERN = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
const FIELD_MAX = {
  name: 200,
  title: 100,
  // The registry schema bounds descriptions at 100; older entries exceed it.
  description: 400,
  version: 255,
  url: 2048,
  summary: 600,
} as const;

export interface McpSubregistryRemote {
  type: string;
  url?: string;
  /** Header names, with whether the source marks them secret/required. */
  headers: {
    name: string;
    secret: boolean;
    required: boolean;
    literal: boolean;
  }[];
  hasVariables: boolean;
}

/** Station's own record of a check, honored only from a trusted source. */
export interface McpStationCuration {
  remote: string;
  authMode: Exclude<RegistryMcpAuthMode, 'unknown'>;
  checkedAt: string;
  summary: string;
  launchStage?: 'preview' | 'developer-preview';
  contentTrust?: 'untrusted';
  /** Station trusts the server's own read-only tool hints. */
  trustReadOnlyHints?: boolean;
}

/** One server entry that passed validation. Unknown fields are not carried. */
export interface McpSubregistryServer {
  name: string;
  version: string;
  schema: string;
  title?: string;
  description: string;
  websiteUrl?: string;
  remotes: McpSubregistryRemote[];
  packageTypes: string[];
  status: 'active' | 'deprecated' | 'deleted';
  /** The source marks this record as the server's latest version. */
  isLatest: boolean;
  /** Present only when the source is trusted to carry Station curation. */
  curation?: McpStationCuration;
}

export interface McpSubregistryRefusal {
  name: string;
  reasons: string[];
}

export type McpSubregistryParseResult =
  | {
      ok: true;
      servers: McpSubregistryServer[];
      refused: McpSubregistryRefusal[];
      nextCursor?: string;
    }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function plainText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= max &&
    !hasUnsafeTextChar(value)
  );
}

function text(
  value: unknown,
  max: number,
  field: string,
  reasons: string[],
): string | undefined {
  if (plainText(value, max)) return value;
  reasons.push(`${field} is missing, too long or not plain text`);
  return undefined;
}

/** An https URL without credentials; anything else is refused by name. */
export function parseHttpsUrl(
  value: unknown,
  field: string,
  reasons: string[],
): string | undefined {
  const url = text(value, FIELD_MAX.url, field, reasons);
  if (url === undefined) return undefined;
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {}
  if (parsed?.protocol !== 'https:') {
    reasons.push(`${field} is not an https URL`);
    return undefined;
  }
  if (parsed.username || parsed.password) {
    reasons.push(`${field} must not carry a user name or password`);
    return undefined;
  }
  return url;
}

function parseRemote(
  value: unknown,
  index: number,
  reasons: string[],
): McpSubregistryRemote | undefined {
  const field = `remotes[${index}]`;
  if (!isRecord(value) || typeof value.type !== 'string') {
    reasons.push(`${field} has no transport type`);
    return undefined;
  }
  const hasVariables =
    (isRecord(value.variables) && Object.keys(value.variables).length > 0) ||
    (typeof value.url === 'string' && value.url.includes('{'));
  const remote: McpSubregistryRemote = {
    type: value.type,
    headers: [],
    hasVariables,
  };
  if (value.url !== undefined) {
    // A templated URL is not a URL until its variables are filled in.
    remote.url = hasVariables
      ? text(value.url, FIELD_MAX.url, `${field}.url`, reasons)
      : parseHttpsUrl(value.url, `${field}.url`, reasons);
  }
  if (value.headers !== undefined && value.headers !== null) {
    if (!Array.isArray(value.headers) || value.headers.length > 16) {
      reasons.push(`${field}.headers must be a list of at most 16`);
    } else {
      value.headers.forEach((header, headerIndex) => {
        if (!isRecord(header) || !plainText(header.name, 128)) {
          reasons.push(`${field}.headers[${headerIndex}] has no name`);
          return;
        }
        remote.headers.push({
          name: header.name,
          secret: header.isSecret === true,
          required: header.isRequired === true,
          literal:
            typeof header.value === 'string' && !header.value.includes('{'),
        });
      });
    }
  }
  return remote;
}

function parseCuration(
  value: unknown,
  reasons: string[],
): McpStationCuration | undefined {
  if (value === undefined) return undefined;
  const field = `_meta.${STATION_CURATION_META_KEY}`;
  if (!isRecord(value)) {
    reasons.push(`${field} is not an object`);
    return undefined;
  }
  const remote = parseHttpsUrl(value.remote, `${field}.remote`, reasons);
  const authMode = value.authMode;
  if (
    authMode !== 'dcr' &&
    authMode !== 'pre-registered-required' &&
    authMode !== 'token' &&
    authMode !== 'none'
  ) {
    reasons.push(`${field}.authMode is not a recorded authorization mode`);
  }
  const checkedAt = text(value.checkedAt, 40, `${field}.checkedAt`, reasons);
  if (checkedAt !== undefined && !Number.isFinite(Date.parse(checkedAt)))
    reasons.push(`${field}.checkedAt is not a date`);
  const summary = text(
    value.summary,
    FIELD_MAX.summary,
    `${field}.summary`,
    reasons,
  );
  const launchStage = value.launchStage;
  if (
    launchStage !== undefined &&
    launchStage !== 'preview' &&
    launchStage !== 'developer-preview'
  )
    reasons.push(`${field}.launchStage is not a known stage`);
  if (value.contentTrust !== undefined && value.contentTrust !== 'untrusted')
    reasons.push(`${field}.contentTrust must be "untrusted" when present`);
  if (
    value.trustReadOnlyHints !== undefined &&
    typeof value.trustReadOnlyHints !== 'boolean'
  )
    reasons.push(`${field}.trustReadOnlyHints must be true or false`);
  if (
    remote === undefined ||
    checkedAt === undefined ||
    summary === undefined ||
    reasons.length > 0
  )
    return undefined;
  return {
    remote,
    authMode: authMode as McpStationCuration['authMode'],
    checkedAt,
    summary,
    ...(launchStage
      ? { launchStage: launchStage as McpStationCuration['launchStage'] }
      : {}),
    ...(value.contentTrust === 'untrusted'
      ? { contentTrust: 'untrusted' as const }
      : {}),
    ...(value.trustReadOnlyHints === true ? { trustReadOnlyHints: true } : {}),
  };
}

function parseEntry(
  value: unknown,
  index: number,
  trustCuration: boolean,
): { server?: McpSubregistryServer; refusal?: McpSubregistryRefusal } {
  const reasons: string[] = [];
  const server = isRecord(value) ? value.server : undefined;
  if (!isRecord(server)) {
    return {
      refusal: {
        name: `servers[${index}]`,
        reasons: ['entry has no server object'],
      },
    };
  }
  const name =
    typeof server.name === 'string' &&
    server.name.length >= 3 &&
    server.name.length <= FIELD_MAX.name &&
    NAME_PATTERN.test(server.name)
      ? server.name
      : undefined;
  if (!name) reasons.push('name is not a reverse-DNS namespace/name');
  const schema =
    typeof server.$schema === 'string' &&
    SUPPORTED_SERVER_SCHEMAS.has(server.$schema)
      ? server.$schema
      : undefined;
  if (!schema) reasons.push('$schema is not a supported server.json revision');
  const version = text(server.version, FIELD_MAX.version, 'version', reasons);
  const description = text(
    server.description,
    FIELD_MAX.description,
    'description',
    reasons,
  );
  const title =
    server.title === undefined
      ? undefined
      : text(server.title, FIELD_MAX.title, 'title', reasons);
  const websiteUrl =
    server.websiteUrl === undefined
      ? undefined
      : parseHttpsUrl(server.websiteUrl, 'websiteUrl', reasons);
  const remotes: McpSubregistryRemote[] = [];
  if (server.remotes !== undefined && server.remotes !== null) {
    if (!Array.isArray(server.remotes) || server.remotes.length > 16) {
      reasons.push('remotes must be a list of at most 16');
    } else {
      server.remotes.forEach((remote, remoteIndex) => {
        const parsed = parseRemote(remote, remoteIndex, reasons);
        if (parsed) remotes.push(parsed);
      });
    }
  }
  const packageTypes: string[] = [];
  if (server.packages !== undefined && server.packages !== null) {
    if (!Array.isArray(server.packages) || server.packages.length > 16) {
      reasons.push('packages must be a list of at most 16');
    } else {
      for (const pkg of server.packages) {
        packageTypes.push(
          isRecord(pkg) && plainText(pkg.registryType, 32)
            ? pkg.registryType
            : 'unknown',
        );
      }
    }
  }
  const meta = isRecord(value) && isRecord(value._meta) ? value._meta : {};
  const official = meta[OFFICIAL_META_KEY];
  let status: McpSubregistryServer['status'] = 'active';
  let isLatest = false;
  if (official !== undefined) {
    if (
      !isRecord(official) ||
      !['active', 'deprecated', 'deleted'].includes(String(official.status))
    ) {
      reasons.push(`_meta.${OFFICIAL_META_KEY}.status is not a known status`);
    } else {
      status = official.status as McpSubregistryServer['status'];
      isLatest = official.isLatest === true;
    }
  }
  // A source other than Station's own cannot confer Station qualification,
  // whatever it writes under Station's namespace.
  const curation = trustCuration
    ? parseCuration(meta[STATION_CURATION_META_KEY], reasons)
    : undefined;
  if (curation && !remotes.some((remote) => remote.url === curation.remote))
    reasons.push("curated remote is not one of the entry's remotes");
  if (reasons.length > 0 || !name || !schema || !version || !description) {
    return { refusal: { name: name ?? `servers[${index}]`, reasons } };
  }
  return {
    server: {
      name,
      version,
      schema,
      description,
      ...(title ? { title } : {}),
      ...(websiteUrl ? { websiteUrl } : {}),
      remotes,
      packageTypes,
      status,
      isLatest,
      ...(curation ? { curation } : {}),
    },
  };
}

/**
 * Parses one `ServerListResponse` page. The document is refused whole when
 * it is not that shape or holds more than `maxServers` records; single
 * entries are refused with every reason and the rest are kept.
 */
export function parseMcpSubregistryPage(
  body: string,
  options: { maxServers: number; trustCuration: boolean },
): McpSubregistryParseResult {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'The subregistry did not return JSON.' };
  }
  if (!isRecord(document) || !Array.isArray(document.servers)) {
    return {
      ok: false,
      reason: 'The subregistry response has no servers list.',
    };
  }
  if (!isRecord(document.metadata)) {
    return { ok: false, reason: 'The subregistry response has no metadata.' };
  }
  if (document.servers.length > options.maxServers) {
    return {
      ok: false,
      reason: `The subregistry lists more than ${options.maxServers} servers.`,
    };
  }
  const nextCursor = document.metadata.nextCursor;
  if (nextCursor !== undefined && !plainText(nextCursor, 512)) {
    return {
      ok: false,
      reason: 'The subregistry page cursor is not plain text.',
    };
  }
  const servers: McpSubregistryServer[] = [];
  const refused: McpSubregistryRefusal[] = [];
  document.servers.forEach((entry, index) => {
    const parsed = parseEntry(entry, index, options.trustCuration);
    if (parsed.server) servers.push(parsed.server);
    if (parsed.refusal) refused.push(parsed.refusal);
  });
  return {
    ok: true,
    servers,
    refused,
    ...(typeof nextCursor === 'string' ? { nextCursor } : {}),
  };
}

/**
 * The integration id a server name is stored under, in the stored tool id
 * grammar (`^[a-z0-9-]+$`): the namespace and name joined by `--`, other
 * separators as `-`. Two names that differ only in case or separator
 * collide here and are refused rather than one silently replacing the other.
 */
export function mcpServerIntegrationId(name: string): string {
  const [namespace, server] = name.toLowerCase().split('/');
  const part = (value: string) => value.replace(/[^a-z0-9]+/g, '-');
  return `${part(namespace)}--${part(server)}`;
}

/**
 * One server per name. A list with several versions of a name keeps the
 * single active-latest choice the source marks; names that cannot be
 * resolved to one version, and names whose ids collide, are refused.
 */
function selectMcpServerVersions(servers: McpSubregistryServer[]): {
  servers: McpSubregistryServer[];
  refused: McpSubregistryRefusal[];
} {
  const byName = new Map<string, McpSubregistryServer[]>();
  for (const server of servers) {
    byName.set(server.name, [...(byName.get(server.name) ?? []), server]);
  }
  const chosen: McpSubregistryServer[] = [];
  const refused: McpSubregistryRefusal[] = [];
  for (const [name, versions] of byName) {
    if (versions.length === 1) {
      chosen.push(versions[0]);
      continue;
    }
    const marked = versions.filter((server) => server.isLatest);
    if (marked.length === 1) chosen.push(marked[0]);
    else
      refused.push({
        name,
        reasons: [
          'the source lists several versions and does not mark exactly one latest',
        ],
      });
  }
  const byId = new Map<string, McpSubregistryServer[]>();
  for (const server of chosen) {
    const id = mcpServerIntegrationId(server.name);
    byId.set(id, [...(byId.get(id) ?? []), server]);
  }
  const unique: McpSubregistryServer[] = [];
  for (const group of byId.values()) {
    if (group.length === 1) unique.push(group[0]);
    else
      for (const server of group)
        refused.push({
          name: server.name,
          reasons: [
            `name collides with ${group
              .filter((other) => other !== server)
              .map((other) => other.name)
              .join(', ')} once stored`,
          ],
        });
  }
  return { servers: unique, refused };
}

class SubregistryRefusedError extends Error {}

async function downloadPage(
  fetchImpl: typeof fetch,
  url: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetchImpl(url, {
    signal,
    redirect: 'error',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new SubregistryRefusedError(
      `The subregistry answered with HTTP status ${response.status}.`,
    );
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new SubregistryRefusedError(
      `The subregistry page is larger than ${maxBytes} bytes.`,
    );
  }
  if (!response.body) return '';
  // Counted as it arrives: a missing or wrong content-length cannot make
  // Station buffer more than the bound.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SubregistryRefusedError(
        `The subregistry page is larger than ${maxBytes} bytes.`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function pageUrl(base: string, cursor: string | undefined): string {
  const url = new URL(base);
  if (cursor !== undefined) url.searchParams.set('cursor', cursor);
  return url.toString();
}

interface Snapshot {
  servers: McpSubregistryServer[];
  refused: McpSubregistryRefusal[];
  fetchedAt: number;
  origin: 'bundled' | 'network' | 'cache';
}

interface CachedIndex {
  fetchedAt: string;
  pages: string[];
}

/**
 * Parses a complete set of pages into one selection. Fails whole when any
 * page fails or the records across pages pass the server bound.
 */
function parseMcpSubregistryPages(
  pages: readonly string[],
  options: { maxServers: number; trustCuration: boolean },
):
  | {
      ok: true;
      servers: McpSubregistryServer[];
      refused: McpSubregistryRefusal[];
    }
  | { ok: false; reason: string } {
  const servers: McpSubregistryServer[] = [];
  const refused: McpSubregistryRefusal[] = [];
  let records = 0;
  for (const body of pages) {
    const parsed = parseMcpSubregistryPage(body, options);
    if (!parsed.ok) return parsed;
    records += parsed.servers.length + parsed.refused.length;
    if (records > options.maxServers) {
      return {
        ok: false,
        reason: `The subregistry lists more than ${options.maxServers} servers.`,
      };
    }
    servers.push(...parsed.servers);
    refused.push(...parsed.refused);
  }
  const selected = selectMcpServerVersions(servers);
  return {
    ok: true,
    servers: selected.servers,
    refused: [...refused, ...selected.refused],
  };
}

export interface McpSubregistrySourceOptions {
  id: string;
  displayName: string;
  origin: 'station' | 'configured';
  /** A network source; mutually exclusive with `bundled`. */
  url?: string;
  /** Pages shipped with Station; never fetched, never stale. */
  bundled?: readonly string[];
  /** Why this source cannot be read at all, such as a refused setting. */
  refusal?: string;
  /** Directory the last good network copy is saved in. */
  cacheDir?: string;
  fetch?: typeof fetch;
  now?: () => number;
  limits?: Partial<McpSubregistryLimits>;
}

export class McpSubregistrySource {
  readonly id: string;
  readonly displayName: string;
  readonly origin: 'station' | 'configured';
  private readonly url?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly limits: McpSubregistryLimits;
  private readonly cacheFile?: string;
  private snapshot: Snapshot | null = null;
  private lastAttemptAt: number | null = null;
  private lastError: string | null = null;
  private loading: Promise<void> | null = null;
  private inflight: Promise<void> | null = null;

  constructor(private readonly options: McpSubregistrySourceOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.origin = options.origin;
    this.url = options.url;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.limits = { ...MCP_SUBREGISTRY_LIMITS, ...options.limits };
    if (options.refusal) this.lastError = options.refusal;
    if (options.url && options.cacheDir) {
      const key = createHash('sha256')
        .update(options.url)
        .digest('hex')
        .slice(0, 24);
      this.cacheFile = join(options.cacheDir, `${key}.json`);
    }
  }

  /** Only the bundled Station curation may carry Station qualification. */
  get trustsCuration(): boolean {
    return this.options.bundled !== undefined && this.origin === 'station';
  }

  /** Loads the bundled pages or the saved copy once. Never rejects. */
  ready(): Promise<void> {
    this.loading ??= this.options.bundled
      ? Promise.resolve(this.loadBundled(this.options.bundled))
      : this.loadCache();
    return this.loading;
  }

  servers(): readonly McpSubregistryServer[] {
    return this.snapshot?.servers ?? [];
  }

  isStale(): boolean {
    return this.snapshot?.origin === 'cache';
  }

  status(): RegistryMcpSourceStatus {
    return {
      id: this.id,
      displayName: this.displayName,
      origin: this.origin,
      freshness:
        this.snapshot === null
          ? 'none'
          : this.snapshot.origin === 'bundled'
            ? 'bundled'
            : this.snapshot.origin === 'network'
              ? 'live'
              : 'stale',
      fetchedAt: this.snapshot
        ? new Date(this.snapshot.fetchedAt).toISOString()
        : null,
      checkedAt:
        this.lastAttemptAt === null
          ? null
          : new Date(this.lastAttemptAt).toISOString(),
      lastError: this.lastError,
      serverCount: this.snapshot?.servers.length ?? 0,
      refused: this.snapshot?.refused.map((entry) => ({ ...entry })) ?? [],
    };
  }

  /** Starts a background download when the listing is due. Returns at once. */
  refreshIfStale(): void {
    if (!this.url) return;
    const now = this.now();
    const fresh =
      this.snapshot?.origin === 'network' &&
      this.snapshot.fetchedAt <= now &&
      now - this.snapshot.fetchedAt < this.limits.refreshAfterMs;
    if (fresh || this.inflight) return;
    if (
      this.lastAttemptAt !== null &&
      now - this.lastAttemptAt < this.limits.retryAfterFailureMs
    )
      return;
    void this.refresh();
  }

  /**
   * Downloads now, unless one is in flight (joined) or the last attempt was
   * within the minimum interval. Never rejects: a failure is recorded in
   * `status().lastError` and the previous listing is kept, marked stale.
   */
  async refresh(): Promise<RegistryMcpSourceStatus> {
    await this.ready();
    if (!this.url) return this.status();
    if (this.inflight) {
      await this.inflight;
      return this.status();
    }
    if (
      this.lastAttemptAt !== null &&
      this.now() - this.lastAttemptAt < this.limits.minRefreshIntervalMs
    )
      return this.status();
    this.inflight = this.download(this.url).finally(() => {
      this.inflight = null;
    });
    await this.inflight;
    return this.status();
  }

  private parse(pages: readonly string[]) {
    return parseMcpSubregistryPages(pages, {
      maxServers: this.limits.maxServers,
      trustCuration: this.trustsCuration,
    });
  }

  private loadBundled(pages: readonly string[]): void {
    const parsed = this.parse(pages);
    if (!parsed.ok) {
      this.lastError = parsed.reason;
      logger.warn('Bundled MCP subregistry refused', { reason: parsed.reason });
      return;
    }
    this.snapshot = {
      servers: parsed.servers,
      refused: parsed.refused,
      fetchedAt: this.now(),
      origin: 'bundled',
    };
  }

  private async download(url: string): Promise<void> {
    this.lastAttemptAt = this.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.limits.fetchTimeoutMs,
    );
    timer.unref?.();
    try {
      const pages: string[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      for (;;) {
        if (pages.length === this.limits.maxPages) {
          throw new SubregistryRefusedError(
            `The subregistry has more than ${this.limits.maxPages} pages.`,
          );
        }
        const body = await downloadPage(
          this.fetchImpl,
          pageUrl(url, cursor),
          this.limits.maxBytes,
          controller.signal,
        );
        const page = parseMcpSubregistryPage(body, {
          maxServers: this.limits.maxServers,
          trustCuration: false,
        });
        if (!page.ok) throw new SubregistryRefusedError(page.reason);
        pages.push(body);
        // Only a missing cursor ends the list. An empty page that still
        // names a next page is followed, within the page bound, so a gap
        // cannot publish a partial index as complete.
        if (page.nextCursor === undefined) break;
        if (seenCursors.has(page.nextCursor))
          throw new SubregistryRefusedError(
            'The subregistry repeated a page cursor.',
          );
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      const parsed = this.parse(pages);
      if (!parsed.ok) throw new SubregistryRefusedError(parsed.reason);
      const fetchedAt = this.now();
      this.snapshot = {
        servers: parsed.servers,
        refused: parsed.refused,
        fetchedAt,
        origin: 'network',
      };
      this.lastError = null;
      await this.saveCache({
        fetchedAt: new Date(fetchedAt).toISOString(),
        pages,
      });
    } catch (error) {
      // The listing kept from an earlier success is now the last good copy.
      if (this.snapshot?.origin === 'network')
        this.snapshot = { ...this.snapshot, origin: 'cache' };
      this.lastError =
        error instanceof SubregistryRefusedError
          ? error.message
          : controller.signal.aborted
            ? `The subregistry did not answer within ${Math.round(this.limits.fetchTimeoutMs / 1000)} seconds.`
            : 'The subregistry could not be reached.';
      logger.warn('MCP subregistry refresh failed', {
        source: this.id,
        reason: this.lastError,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async loadCache(): Promise<void> {
    if (!this.cacheFile) return;
    try {
      const info = await stat(this.cacheFile);
      if (info.size > this.limits.maxBytes * this.limits.maxPages * 2 + 4096) {
        throw new SubregistryRefusedError(
          'The saved subregistry copy is too large.',
        );
      }
      const saved = JSON.parse(
        await readFile(this.cacheFile, 'utf8'),
      ) as Partial<CachedIndex>;
      const fetchedAt = Date.parse(String(saved.fetchedAt));
      if (
        !Array.isArray(saved.pages) ||
        !saved.pages.every((page) => typeof page === 'string') ||
        !Number.isFinite(fetchedAt)
      ) {
        throw new SubregistryRefusedError(
          'The saved subregistry copy is unreadable.',
        );
      }
      const parsed = this.parse(saved.pages);
      if (!parsed.ok) throw new SubregistryRefusedError(parsed.reason);
      // A download that finished first is newer than the saved copy.
      this.snapshot ??= {
        servers: parsed.servers,
        refused: parsed.refused,
        fetchedAt,
        origin: 'cache',
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      logger.warn('Ignored the saved MCP subregistry copy', {
        source: this.id,
        reason:
          error instanceof SubregistryRefusedError
            ? error.message
            : 'The saved subregistry copy is unreadable.',
      });
    }
  }

  private async saveCache(cached: CachedIndex): Promise<void> {
    if (!this.cacheFile) return;
    try {
      await mkdir(join(this.cacheFile, '..'), { recursive: true });
      const temporary = `${this.cacheFile}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(cached), 'utf8');
      await rename(temporary, this.cacheFile);
    } catch (error) {
      logger.warn('Could not save the MCP subregistry copy', {
        source: this.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
