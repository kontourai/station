/**
 * Per-model image input for OpenCode connections.
 *
 * ACP reports `promptCapabilities.image` once per ENGINE, and OpenCode
 * answers `true` for itself while swapping an image for an error text when the
 * selected model has no image input. The handshake's model option carries only
 * `{value, name}`, so the modality is not on the wire. OpenCode's own listing
 * (`opencode models --verbose`) is the first-party source: one `provider/model`
 * line per model followed by a pretty-printed JSON object whose
 * `capabilities.input.image` is a boolean.
 *
 * This module reads that listing OFF the request path. A successful ACP
 * handshake for an OpenCode connection calls `refreshOpenCodeModelCapabilities`
 * (detached, best effort); `acpRuntimeCatalogStatus` only reads the cache. Any
 * failure (missing binary, non-zero exit, timeout, oversized or unrecognised
 * output) leaves the answer unknown, which consumers must not read as "no".
 *
 * No timers: the cache is re-read only when a handshake completes and the
 * entry is absent, was invalidated, was built for different launch settings,
 * or is older than its TTL. Each listing spawns the engine binary, and
 * archive#1908 measured that spawn as leaking extracted files, so it is rate
 * limited rather than repeated on every probe.
 */
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import {
  augmentedSpawnEnv,
  findCliBinaryAsync,
} from '../../providers/auth/cli-auth.js';
import { forceKillProcess, spawnOwnedChild } from '../infra/process-utils.js';

const OPENCODE_LISTING_TIMEOUT_MS = 8_000;
/** The real listing is ~550KB for ~460 models; this is generous headroom. */
const OPENCODE_LISTING_MAX_BYTES = 2 * 1024 * 1024;
const OPENCODE_CAPABILITIES_TTL_MS = 60 * 60_000;
/** A failed listing is retried sooner than a good one is refreshed. */
const OPENCODE_CAPABILITIES_FAILURE_TTL_MS = 15 * 60_000;

export type OpenCodeListingFailure =
  | 'not-installed'
  | 'spawn-failed'
  | 'timeout'
  | 'exit'
  | 'oversized';

export type OpenCodeListingResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: OpenCodeListingFailure };

export interface OpenCodeListingOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Arguments placed before `models --verbose` (a launcher form). */
  argvPrefix?: string[];
  resolveCommand?: (command: string) => Promise<string | null>;
  env?: () => Promise<NodeJS.ProcessEnv>;
}

export interface OpenCodeCapabilitiesDeps extends OpenCodeListingOptions {
  /** Replaces the whole listing step; tests and alternate launchers only. */
  run?: (command: string) => Promise<OpenCodeListingResult>;
  now?: () => number;
  logger?: {
    warn: (message: string, fields?: Record<string, unknown>) => void;
  };
}

interface CacheEntry {
  /** Launch settings the listing was read with; a change makes it stale. */
  key: string;
  models: Map<string, boolean>;
  failed: boolean;
  at: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, { generation: number; task: Promise<void> }>();
/** Bumped by invalidation so a listing that was running discards its result. */
const generations = new Map<string, number>();

/** The binary name without directory or a Windows launcher extension. */
function commandBasename(command: string): string {
  return path
    .basename(command.replace(/\\/g, '/'))
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, '');
}

function isOpenCodeCommand(command: string): boolean {
  return commandBasename(command) === 'opencode';
}

/**
 * Parse `opencode models --verbose`. Unknown shapes yield an empty map and a
 * model whose block is malformed or has no boolean image flag is omitted;
 * neither throws. A model with variants also yields `<id>/<variant>`, because
 * the ACP model option value carries the variant suffix.
 */
export function parseOpenCodeModelListing(
  stdout: string,
): Map<string, boolean> {
  const result = new Map<string, boolean>();
  if (typeof stdout !== 'string') return result;
  let header: string | null = null;
  let block: string[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (header === null) {
      if (line.length > 0 && !/^[\s{}"[\]]/.test(line)) {
        header = line.trim();
        block = [];
      }
      continue;
    }
    block.push(line);
    if (line !== '}') continue;
    try {
      const model: unknown = JSON.parse(block.join('\n'));
      const image = (
        model as {
          capabilities?: { input?: { image?: unknown } };
        } | null
      )?.capabilities?.input?.image;
      if (typeof image === 'boolean') {
        result.set(header, image);
        const variants = (model as { variants?: unknown }).variants;
        if (
          variants &&
          typeof variants === 'object' &&
          !Array.isArray(variants)
        ) {
          for (const variant of Object.keys(variants)) {
            result.set(`${header}/${variant}`, image);
          }
        }
      }
    } catch {
      // A malformed block is one unknown model, not a failed listing.
    }
    header = null;
  }
  return result;
}

export async function runOpenCodeModelListing(
  command: string,
  options: OpenCodeListingOptions,
): Promise<OpenCodeListingResult> {
  const resolved = await (options.resolveCommand ?? findCliBinaryAsync)(
    command,
  );
  if (!resolved) return { ok: false, reason: 'not-installed' };
  const env = await (options.env ?? augmentedSpawnEnv)();
  const timeoutMs = options.timeoutMs ?? OPENCODE_LISTING_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? OPENCODE_LISTING_MAX_BYTES;
  return new Promise<OpenCodeListingResult>((resolve) => {
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let child: ChildProcess | undefined;
    let release: (() => void) | undefined;
    const finish = (result: OpenCodeListingResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!result.ok && child) {
        // The whole process group, so a wrapper's grandchild goes with it.
        const doomed = child;
        void forceKillProcess(doomed)
          .catch(() => undefined)
          .finally(() => release?.());
      } else {
        release?.();
      }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: 'timeout' }),
      timeoutMs,
    );
    try {
      // An argv array, no shell: nothing in the command or arguments is
      // interpreted. The command is the connection's own configured binary.
      // Registered as an owned child (archive#1863) so a Station that dies
      // mid-listing has the engine reaped by the next startup sweep.
      const owned = spawnOwnedChild(
        resolved,
        [...(options.argvPrefix ?? []), 'models', '--verbose'],
        { env, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      child = owned.proc;
      release = owned.release;
    } catch {
      finish({ ok: false, reason: 'spawn-failed' });
      return;
    }
    const spawned = child;
    spawned.on('error', () => finish({ ok: false, reason: 'spawn-failed' }));
    spawned.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      // Refuse rather than truncate: a cut listing would parse as a
      // plausible but incomplete one.
      if (bytes > maxBytes) {
        finish({ ok: false, reason: 'oversized' });
        return;
      }
      chunks.push(chunk);
    });
    spawned.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, stdout: Buffer.concat(chunks).toString('utf8') });
      } else {
        finish({ ok: false, reason: 'exit' });
      }
    });
  });
}

function cacheKey(config: ACPConnectionConfig): string {
  return JSON.stringify([config.command, config.args ?? [], config.cwd ?? '']);
}

/** Drop a connection's cached answer (reconnect, removal, config change). */
export function invalidateOpenCodeModelCapabilities(
  connectionId: string,
): void {
  cache.delete(connectionId);
  generations.set(connectionId, (generations.get(connectionId) ?? 0) + 1);
}

/** Test seam: forget everything. */
export function resetOpenCodeModelCapabilities(): void {
  cache.clear();
  inFlight.clear();
  generations.clear();
}

/**
 * The cached image-input answer for one catalog model option, or `undefined`
 * (unknown). Reads memory only; never spawns.
 */
export function openCodeModelImageInput(
  connectionId: string | undefined,
  modelId: string,
  /**
   * The connection's CURRENT configuration. When given, an entry read with
   * different launch settings (an edit without a reconnect) is unknown.
   */
  current?: ACPConnectionConfig,
): boolean | undefined {
  if (!connectionId) return undefined;
  const entry = cache.get(connectionId);
  if (!entry) return undefined;
  if (current && entry.key !== cacheKey(current)) return undefined;
  return entry.models.get(modelId);
}

/**
 * Called when an ACP handshake for `config` completes. Starts the listing in
 * the background when this connection is OpenCode and its cached answer is
 * missing or stale. The returned promise never rejects; production callers
 * ignore it.
 */
export function refreshOpenCodeModelCapabilities(
  config: ACPConnectionConfig,
  deps: OpenCodeCapabilitiesDeps = {},
): Promise<void> {
  if (!isOpenCodeCommand(config.command)) return Promise.resolve();
  const now = (deps.now ?? Date.now)();
  const key = cacheKey(config);
  const cached = cache.get(config.id);
  if (
    cached &&
    cached.key === key &&
    now - cached.at <
      (cached.failed
        ? OPENCODE_CAPABILITIES_FAILURE_TTL_MS
        : OPENCODE_CAPABILITIES_TTL_MS)
  ) {
    return Promise.resolve();
  }
  const generation = generations.get(config.id) ?? 0;
  // Join only a listing started after the latest invalidation; an older one
  // will discard its result.
  const running = inFlight.get(config.id);
  if (running && running.generation === generation) return running.task;
  const task = (async () => {
    let models = new Map<string, boolean>();
    let failure: string | null = null;
    try {
      const listing = await (deps.run
        ? deps.run(config.command)
        : runOpenCodeModelListing(config.command, deps));
      if (listing.ok) {
        models = parseOpenCodeModelListing(listing.stdout);
        if (models.size === 0) failure = 'unrecognised-output';
      } else {
        failure = listing.reason;
      }
    } catch {
      failure = 'spawn-failed';
    }
    if ((generations.get(config.id) ?? 0) !== generation) return;
    // A failed refresh keeps the last good answers for this same launch
    // settings; only the retry cadence records the failure.
    const previous = cache.get(config.id);
    cache.set(config.id, {
      key,
      models:
        failure !== null && previous && previous.key === key
          ? previous.models
          : models,
      failed: failure !== null,
      at: (deps.now ?? Date.now)(),
    });
    if (failure) {
      // The reason only; no model names, paths, stderr or credentials.
      deps.logger?.warn(
        'OpenCode per-model image support is unknown: listing failed',
        { id: config.id, reason: failure },
      );
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      if (inFlight.get(config.id)?.task === task) inFlight.delete(config.id);
    });
  inFlight.set(config.id, { generation, task });
  return task;
}
