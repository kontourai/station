/**
 * The public agent registry (agentclientprotocol.com) as a catalogue source:
 * download the index, refuse it whole when it is oversized or malformed,
 * refuse single listings with every reason, keep the last good copy on disk
 * and serve it when the network is unavailable. Nothing here launches,
 * downloads or installs an agent; mapping listings to catalogue entries is
 * `public-agent-registry-catalog.ts`.
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ACPPublicRegistrySourceStatus,
  hasUnsafeTextChar,
} from '@kontourai/station-contracts/acp';
import { findCliBinary } from '../../providers/auth/cli-auth.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger({ name: 'public-agent-registry' });

export const PUBLIC_AGENT_REGISTRY_URL =
  'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

/**
 * The 2026-10-21 index is 60 KB with 43 listings; these leave room for
 * growth and refuse anything an order of magnitude past it.
 */
export const PUBLIC_AGENT_REGISTRY_LIMITS = {
  maxBytes: 1024 * 1024,
  maxAgents: 500,
  fetchTimeoutMs: 10_000,
  /** A listing older than this is refreshed when the catalogue is read. */
  refreshAfterMs: 24 * 60 * 60 * 1000,
  /** After a failed attempt, the catalogue read waits this long to retry. */
  retryAfterFailureMs: 15 * 60 * 1000,
  /** Requested refreshes closer together than this reuse the last result. */
  minRefreshIntervalMs: 30 * 1000,
} as const;

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLATFORM_KEY_PATTERN = /^(darwin|linux|windows)-(aarch64|x86_64)$/;
const FIELD_MAX = {
  id: 64,
  name: 80,
  description: 400,
  version: 64,
  author: 120,
  authors: 16,
  license: 80,
  url: 400,
  cmd: 400,
  package: 214,
  arg: 400,
  args: 32,
  env: 16,
  envValue: 400,
} as const;

export type PublicRegistryPackageKind = 'npx' | 'uvx';

export interface PublicRegistryBinaryTarget {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

export interface PublicRegistryPackage {
  kind: PublicRegistryPackageKind;
  package: string;
  args: string[];
  env?: Record<string, string>;
}

/** One listing that passed validation. Unknown fields are not carried. */
export interface PublicRegistryAgent {
  id: string;
  name: string;
  version: string;
  description?: string;
  publishers: string[];
  license?: string;
  websiteUrl?: string;
  repositoryUrl?: string;
  /** Keyed by the registry's `os-arch` platform key. */
  binary: Record<string, PublicRegistryBinaryTarget>;
  packages: PublicRegistryPackage[];
  /** Distribution kinds this Station does not know, kept for the reason text. */
  unknownDistributions: string[];
}

export interface PublicRegistryRefusal {
  id: string;
  reasons: string[];
}

export type PublicRegistryParseResult =
  | {
      ok: true;
      agents: PublicRegistryAgent[];
      refused: PublicRegistryRefusal[];
    }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(
  value: unknown,
  max: number,
  field: string,
  reasons: string[],
): string | undefined {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > max ||
    hasUnsafeTextChar(value)
  ) {
    reasons.push(`${field} is missing, too long or not plain text`);
    return undefined;
  }
  return value;
}

function optionalText(
  value: unknown,
  max: number,
  field: string,
  reasons: string[],
): string | undefined {
  return value === undefined ? undefined : text(value, max, field, reasons);
}

function optionalHttpsUrl(
  value: unknown,
  field: string,
  reasons: string[],
): string | undefined {
  if (value === undefined) return undefined;
  const url = text(value, FIELD_MAX.url, field, reasons);
  if (url === undefined) return undefined;
  try {
    if (new URL(url).protocol === 'https:') return url;
  } catch {}
  reasons.push(`${field} is not an https URL`);
  return undefined;
}

function argList(value: unknown, field: string, reasons: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > FIELD_MAX.args) {
    reasons.push(`${field} must be a list of at most ${FIELD_MAX.args}`);
    return [];
  }
  const args: string[] = [];
  value.forEach((arg, index) => {
    if (
      typeof arg !== 'string' ||
      arg.length > FIELD_MAX.arg ||
      hasUnsafeTextChar(arg)
    ) {
      reasons.push(`${field}[${index}] is not a plain argument`);
    } else args.push(arg);
  });
  return args;
}

function envMap(
  value: unknown,
  field: string,
  reasons: string[],
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).length > FIELD_MAX.env) {
    reasons.push(`${field} must be an object of at most ${FIELD_MAX.env}`);
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (
      !ENV_NAME_PATTERN.test(name) ||
      typeof entry !== 'string' ||
      entry.length > FIELD_MAX.envValue ||
      hasUnsafeTextChar(entry)
    ) {
      reasons.push(`${field}.${name.slice(0, 64)} is not a plain setting`);
    } else env[name] = entry;
  }
  return env;
}

function parseAgent(
  raw: unknown,
): { agent: PublicRegistryAgent } | { refusal: PublicRegistryRefusal } {
  const reasons: string[] = [];
  if (!isRecord(raw)) {
    return { refusal: { id: '(unknown)', reasons: ['not an object'] } };
  }
  const rawId = raw.id;
  const id =
    typeof rawId === 'string' &&
    rawId.length <= FIELD_MAX.id &&
    ID_PATTERN.test(rawId)
      ? rawId
      : undefined;
  if (id === undefined) {
    reasons.push('id must be lowercase letters, digits and single hyphens');
  }
  const name = text(raw.name, FIELD_MAX.name, 'name', reasons);
  const version = text(raw.version, FIELD_MAX.version, 'version', reasons);
  if (version !== undefined && !VERSION_PATTERN.test(version)) {
    reasons.push('version is not a plain version string');
  }
  const description = optionalText(
    raw.description,
    FIELD_MAX.description,
    'description',
    reasons,
  );
  const publishers: string[] = [];
  if (
    !Array.isArray(raw.authors) ||
    raw.authors.length === 0 ||
    raw.authors.length > FIELD_MAX.authors
  ) {
    reasons.push(`authors must list 1-${FIELD_MAX.authors} publishers`);
  } else {
    raw.authors.forEach((author, index) => {
      const value = text(
        author,
        FIELD_MAX.author,
        `authors[${index}]`,
        reasons,
      );
      if (value !== undefined) publishers.push(value);
    });
  }
  const license = optionalText(
    raw.license,
    FIELD_MAX.license,
    'license',
    reasons,
  );
  const websiteUrl = optionalHttpsUrl(raw.website, 'website', reasons);
  const repositoryUrl = optionalHttpsUrl(raw.repository, 'repository', reasons);

  const binary: Record<string, PublicRegistryBinaryTarget> = {};
  const packages: PublicRegistryPackage[] = [];
  const unknownDistributions: string[] = [];
  if (
    !isRecord(raw.distribution) ||
    Object.keys(raw.distribution).length === 0
  ) {
    reasons.push('distribution must name at least one way to run the agent');
  } else {
    for (const [kind, spec] of Object.entries(raw.distribution)) {
      if (kind === 'binary') {
        if (!isRecord(spec)) {
          reasons.push('distribution.binary must be an object');
          continue;
        }
        for (const [platform, target] of Object.entries(spec)) {
          // A platform this Station has no name for is ignored, not refused:
          // it cannot be this host either way.
          if (!PLATFORM_KEY_PATTERN.test(platform)) continue;
          const at = `distribution.binary.${platform}`;
          if (!isRecord(target)) {
            reasons.push(`${at} must be an object`);
            continue;
          }
          const cmd = text(target.cmd, FIELD_MAX.cmd, `${at}.cmd`, reasons);
          const args = argList(target.args, `${at}.args`, reasons);
          const env = envMap(target.env, `${at}.env`, reasons);
          if (cmd !== undefined) {
            binary[platform] = { cmd, args, ...(env ? { env } : {}) };
          }
        }
      } else if (kind === 'npx' || kind === 'uvx') {
        const at = `distribution.${kind}`;
        if (!isRecord(spec)) {
          reasons.push(`${at} must be an object`);
          continue;
        }
        const pkg = text(
          spec.package,
          FIELD_MAX.package,
          `${at}.package`,
          reasons,
        );
        const args = argList(spec.args, `${at}.args`, reasons);
        const env = envMap(spec.env, `${at}.env`, reasons);
        if (pkg !== undefined) {
          packages.push({ kind, package: pkg, args, ...(env ? { env } : {}) });
        }
      } else {
        unknownDistributions.push(kind.slice(0, 32));
      }
    }
  }

  if (reasons.length > 0 || id === undefined) {
    return {
      refusal: {
        id:
          id ?? (typeof rawId === 'string' ? rawId.slice(0, 64) : '(unknown)'),
        reasons,
      },
    };
  }
  return {
    agent: {
      id,
      name: name as string,
      version: version as string,
      ...(description ? { description } : {}),
      publishers,
      ...(license ? { license } : {}),
      ...(websiteUrl ? { websiteUrl } : {}),
      ...(repositoryUrl ? { repositoryUrl } : {}),
      binary,
      packages,
      unknownDistributions,
    },
  };
}

/**
 * Validates a downloaded index. The index is refused whole when it is not
 * format 1.x, not the expected shape, or lists more agents than the bound;
 * a single listing that fails is refused with its reasons and the rest kept.
 */
export function parsePublicAgentRegistry(
  body: string,
  limits: Pick<
    typeof PUBLIC_AGENT_REGISTRY_LIMITS,
    'maxBytes' | 'maxAgents'
  > = PUBLIC_AGENT_REGISTRY_LIMITS,
): PublicRegistryParseResult {
  if (Buffer.byteLength(body, 'utf8') > limits.maxBytes) {
    return {
      ok: false,
      reason: `The registry index is larger than ${limits.maxBytes} bytes.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'The registry index is not valid JSON.' };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.agents)) {
    return {
      ok: false,
      reason: 'The registry index has no list of agents.',
    };
  }
  if (typeof parsed.version !== 'string' || !/^1(\.|$)/.test(parsed.version)) {
    return {
      ok: false,
      reason:
        'The registry index is in a format version Station does not read.',
    };
  }
  if (parsed.agents.length > limits.maxAgents) {
    return {
      ok: false,
      reason: `The registry index lists more than ${limits.maxAgents} agents.`,
    };
  }
  const agents: PublicRegistryAgent[] = [];
  const refused: PublicRegistryRefusal[] = [];
  const seen = new Set<string>();
  for (const raw of parsed.agents) {
    const result = parseAgent(raw);
    if ('refusal' in result) {
      refused.push(result.refusal);
    } else if (seen.has(result.agent.id)) {
      refused.push({ id: result.agent.id, reasons: ['listed more than once'] });
    } else {
      seen.add(result.agent.id);
      agents.push(result.agent);
    }
  }
  return { ok: true, agents, refused };
}

class RegistryRefusedError extends Error {}

async function downloadIndex(
  fetchImpl: typeof fetch,
  url: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  // No credentials or cookies: the index is public and nothing of this
  // Station's goes with the request.
  const response = await fetchImpl(url, {
    signal,
    credentials: 'omit',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new RegistryRefusedError(
      `The registry answered with HTTP status ${response.status}.`,
    );
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RegistryRefusedError(
      `The registry index is larger than ${maxBytes} bytes.`,
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
      throw new RegistryRefusedError(
        `The registry index is larger than ${maxBytes} bytes.`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface CachedIndex {
  fetchedAt: string;
  body: string;
}

export interface PublicAgentRegistrySourceOptions {
  /** Directory the last good index is saved in. */
  cacheDir: string;
  fetch?: typeof fetch;
  now?: () => number;
  url?: string;
  limits?: Partial<typeof PUBLIC_AGENT_REGISTRY_LIMITS>;
  /** Whether a program is on the host's search PATH. */
  commandExists?: (command: string) => boolean;
}

export class PublicAgentRegistrySource {
  readonly commandExists: (command: string) => boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly url: string;
  private readonly limits: typeof PUBLIC_AGENT_REGISTRY_LIMITS;
  private readonly cacheFile: string;
  private snapshot: {
    agents: PublicRegistryAgent[];
    refused: PublicRegistryRefusal[];
    fetchedAt: number;
    origin: 'network' | 'cache';
  } | null = null;
  private lastAttemptAt: number | null = null;
  private lastError: string | null = null;
  private loading: Promise<void> | null = null;
  private inflight: Promise<void> | null = null;

  constructor(options: PublicAgentRegistrySourceOptions) {
    this.cacheFile = join(options.cacheDir, 'registry.json');
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.url = options.url ?? PUBLIC_AGENT_REGISTRY_URL;
    this.limits = { ...PUBLIC_AGENT_REGISTRY_LIMITS, ...options.limits };
    this.commandExists =
      options.commandExists ?? ((command) => findCliBinary(command) !== null);
  }

  /** Reads the saved copy once. Never rejects; a bad copy is ignored. */
  ready(): Promise<void> {
    this.loading ??= this.loadCache();
    return this.loading;
  }

  agents(): readonly PublicRegistryAgent[] {
    return this.snapshot?.agents ?? [];
  }

  status(): ACPPublicRegistrySourceStatus {
    return {
      enabled: true,
      origin: this.snapshot?.origin ?? 'none',
      fetchedAt: this.snapshot
        ? new Date(this.snapshot.fetchedAt).toISOString()
        : null,
      checkedAt:
        this.lastAttemptAt === null
          ? null
          : new Date(this.lastAttemptAt).toISOString(),
      lastError: this.lastError,
      refreshing: this.inflight !== null,
      refused: this.snapshot?.refused.map((entry) => ({ ...entry })) ?? [],
    };
  }

  /**
   * Starts a download in the background when the listing is older than the
   * refresh interval and the last attempt is not too recent. Returns at once.
   */
  refreshIfStale(): void {
    const now = this.now();
    const fresh =
      this.snapshot !== null &&
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
   * Downloads the index now, unless one is in flight (joined) or the last
   * attempt was within the minimum interval (its result stands). Never
   * rejects: a failure is recorded in `status().lastError` and the previous
   * listing is kept.
   */
  async refresh(): Promise<ACPPublicRegistrySourceStatus> {
    await this.ready();
    if (this.inflight) {
      await this.inflight;
      return this.status();
    }
    if (
      this.lastAttemptAt !== null &&
      this.now() - this.lastAttemptAt < this.limits.minRefreshIntervalMs
    ) {
      return this.status();
    }
    this.inflight = this.download().finally(() => {
      this.inflight = null;
    });
    await this.inflight;
    return this.status();
  }

  private async download(): Promise<void> {
    this.lastAttemptAt = this.now();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.limits.fetchTimeoutMs,
    );
    timer.unref?.();
    try {
      const body = await downloadIndex(
        this.fetchImpl,
        this.url,
        this.limits.maxBytes,
        controller.signal,
      );
      const parsed = parsePublicAgentRegistry(body, this.limits);
      if (!parsed.ok) throw new RegistryRefusedError(parsed.reason);
      const fetchedAt = this.now();
      this.snapshot = {
        agents: parsed.agents,
        refused: parsed.refused,
        fetchedAt,
        origin: 'network',
      };
      this.lastError = null;
      await this.saveCache({
        fetchedAt: new Date(fetchedAt).toISOString(),
        body,
      });
    } catch (error) {
      this.lastError =
        error instanceof RegistryRefusedError
          ? error.message
          : controller.signal.aborted
            ? `The registry did not answer within ${Math.round(this.limits.fetchTimeoutMs / 1000)} seconds.`
            : 'The registry could not be reached.';
      logger.warn('Public agent registry refresh failed', {
        reason: this.lastError,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async loadCache(): Promise<void> {
    try {
      const info = await stat(this.cacheFile);
      // The saved body plus its small wrapper; anything larger was not
      // written by this code.
      if (info.size > this.limits.maxBytes * 2 + 4096) {
        throw new RegistryRefusedError('The saved registry copy is too large.');
      }
      const saved = JSON.parse(
        await readFile(this.cacheFile, 'utf8'),
      ) as Partial<CachedIndex>;
      const fetchedAt = Date.parse(String(saved.fetchedAt));
      if (typeof saved.body !== 'string' || !Number.isFinite(fetchedAt)) {
        throw new RegistryRefusedError(
          'The saved registry copy is unreadable.',
        );
      }
      const parsed = parsePublicAgentRegistry(saved.body, this.limits);
      if (!parsed.ok) throw new RegistryRefusedError(parsed.reason);
      // A download that finished first is newer than the saved copy.
      this.snapshot ??= {
        agents: parsed.agents,
        refused: parsed.refused,
        fetchedAt,
        origin: 'cache',
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      const reason =
        error instanceof RegistryRefusedError
          ? error.message
          : 'The saved registry copy is unreadable.';
      logger.warn('Ignored the saved public agent registry copy', { reason });
    }
  }

  private async saveCache(cached: CachedIndex): Promise<void> {
    try {
      await mkdir(join(this.cacheFile, '..'), { recursive: true });
      const temporary = `${this.cacheFile}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(cached), 'utf8');
      await rename(temporary, this.cacheFile);
    } catch (error) {
      // The listing in memory is still good; only the offline copy is stale.
      logger.warn('Could not save the public agent registry copy', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * The source for a Station home, or `undefined` when this Station does not
 * read the public registry: `STATION_PUBLIC_AGENT_REGISTRY=off`, or the
 * deterministic first-run mode that also turns off engine detection.
 */
export function createPublicAgentRegistrySource(
  stationHomeDir: string,
  env: NodeJS.ProcessEnv = process.env,
): PublicAgentRegistrySource | undefined {
  if (env.STATION_PUBLIC_AGENT_REGISTRY === 'off') return undefined;
  if (env.STATION_E2E_FIRST_RUN === '1') return undefined;
  return new PublicAgentRegistrySource({
    cacheDir: join(stationHomeDir, 'cache', 'public-agent-registry'),
  });
}
