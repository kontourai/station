import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import {
  PLUGIN_DRAFT_LEASE_TTL_MS,
  type PluginDraftDiagnostic,
  type PluginDraftPane,
  type PluginDraftStatus,
} from '@kontourai/station-contracts/plugin-draft';
import type {
  PluginDraftBuildOptions,
  PluginDraftBuildResult,
} from '@kontourai/station-shared/build';
import { readBoundedRegularFileSync } from '@kontourai/station-shared/regular-file';
import {
  type FallbackWatchOptions,
  type WatchHandle,
  watchWithFallback,
} from '@kontourai/station-shared/source-watch';
import { buildPluginDraftInChildProcess } from './plugin-draft-build-process.js';
import { parsePluginManifestDocumentWithFormat } from './plugin-manifest-loader.js';

/**
 * Plugin draft preview (epic #2323 S3): watches a Project folder and builds
 * its plugin into host-owned storage, so the Project can preview the pane
 * without installing it.
 *
 * What this service is NOT: an execution authority. It produces bytes and a
 * status. The bundle runs only in a viewer's tab, and only after that viewer
 * explicitly chooses to run the revision (the UI's guardrail). Nothing here
 * installs, grants, or registers anything, and nothing is written into the
 * Project folder.
 *
 * Resource bounds, because the host is shared and a draft rebuilds on every
 * save: a lease keeps one watcher alive for {@link PLUGIN_DRAFT_LEASE_TTL_MS}
 * and must be refreshed by an open pane; concurrent esbuild runs are capped
 * across all drafts; the number of simultaneously leased drafts is capped;
 * and each draft keeps at most {@link RETAINED_GENERATIONS} revisions on disk.
 */

const DRAFT_ID_DOMAIN = 'station.plugin-draft.v1';
const RETAINED_GENERATIONS = 2;
const DEFAULT_MAX_CONCURRENT_BUILDS = 2;
const DEFAULT_MAX_ACTIVE_LEASES = 8;
const DEFAULT_DEBOUNCE_MS = 300;
/**
 * How long one draft build may hold a build slot. A build that never settles
 * (an input that blocks a read, a wedged esbuild) would otherwise hold one of
 * the few global slots forever and starve every draft on the Station.
 */
const DEFAULT_BUILD_TIMEOUT_MS = 60_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MIN_FORCED_REBUILD_INTERVAL_MS = 5_000;
const WATCHED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.css',
  '.json',
]);
const SKIPPED_SEGMENTS = new Set(['node_modules', 'dist', '.git']);

interface Logger {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface PluginDraftServiceOptions {
  /** `<station home>/plugin-drafts`. Owned entirely by this service. */
  readonly draftsRoot: string;
  readonly emitRebuilt: (event: {
    projectSlug: string;
    draftId: string;
    generation: number;
  }) => void;
  readonly logger?: Logger;
  readonly leaseTtlMs?: number;
  readonly maxConcurrentBuilds?: number;
  readonly maxActiveLeases?: number;
  readonly debounceMs?: number;
  /** Scan interval for the watcher's polling fallback (tests shorten it). */
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly buildTimeoutMs?: number;
  /** Seams for tests; production uses the shared builder and watcher. */
  readonly build?: (
    options: PluginDraftBuildOptions,
  ) => Promise<PluginDraftBuildResult>;
  readonly watch?: (options: FallbackWatchOptions) => WatchHandle;
}

interface DraftGeneration {
  readonly generation: number;
  readonly dir: string;
  readonly hasCss: boolean;
  readonly digest: string;
  readonly builtAt: string;
}

interface DraftEntry {
  readonly draftId: string;
  readonly projectSlug: string;
  readonly root: string;
  expiresAt: number;
  watcher?: WatchHandle;
  state: PluginDraftStatus['state'];
  building: boolean;
  pending: boolean;
  released: boolean;
  diagnostics: PluginDraftDiagnostic[];
  panes: PluginDraftPane[];
  pluginName?: string;
  pluginVersion?: string;
  generations: DraftGeneration[];
  lastForcedRebuildAt?: number;
}

export function pluginDraftId(realRoot: string, projectSlug: string): string {
  const digest = createHash('sha256')
    .update(`${DRAFT_ID_DOMAIN}\0${realRoot}\0${projectSlug}`)
    .digest('hex')
    .slice(0, 32);
  // The `draft_` prefix keeps the identity outside the hex namespace an
  // installation's origin digest occupies, so the two can never be equal
  // strings, independent of the domain separation above.
  return `draft_${digest}`;
}

function idleStatus(projectSlug: string): PluginDraftStatus {
  return {
    projectSlug,
    state: 'idle',
    generation: null,
    hasCss: false,
    panes: [],
    diagnostics: [],
  };
}

function unavailable(projectSlug: string, text: string): PluginDraftStatus {
  return {
    ...idleStatus(projectSlug),
    state: 'unavailable',
    diagnostics: [{ text }],
  };
}

export class PluginDraftService {
  /**
   * Distinguishes this process's revisions from a previous lifetime's. The
   * generation counter restarts at 1 whenever a lease is recreated, so a
   * generation number alone would let "revision 2" name different bytes
   * before and after a restart.
   */
  private readonly lifetime = randomBytes(6).toString('hex');
  private readonly entries = new Map<string, DraftEntry>();
  private readonly buildQueue: Array<() => void> = [];
  private activeBuilds = 0;
  private readonly sweep: ReturnType<typeof setInterval>;
  private readonly leaseTtlMs: number;
  private readonly maxConcurrentBuilds: number;
  private readonly maxActiveLeases: number;
  private readonly now: () => number;
  private readonly build: NonNullable<PluginDraftServiceOptions['build']>;
  private readonly watch: NonNullable<PluginDraftServiceOptions['watch']>;

  constructor(private readonly options: PluginDraftServiceOptions) {
    this.leaseTtlMs = options.leaseTtlMs ?? PLUGIN_DRAFT_LEASE_TTL_MS;
    this.maxConcurrentBuilds =
      options.maxConcurrentBuilds ?? DEFAULT_MAX_CONCURRENT_BUILDS;
    this.maxActiveLeases = options.maxActiveLeases ?? DEFAULT_MAX_ACTIVE_LEASES;
    this.now = options.now ?? Date.now;
    // Each draft build runs in a disposable process that the deadline kills
    // (see plugin-draft-build-process.ts); never in this process's esbuild.
    this.build = options.build ?? buildPluginDraftInChildProcess;
    this.watch = options.watch ?? watchWithFallback;
    // Drafts from a previous process have no lease and no reader; they are
    // cache, and a fresh process starts from none.
    rmSync(options.draftsRoot, { recursive: true, force: true });
    this.sweep = setInterval(
      () => this.releaseExpired(),
      Math.max(1_000, Math.min(this.leaseTtlMs / 3, 30_000)),
    );
    this.sweep.unref?.();
  }

  /** Starts or refreshes the lease for a Project's draft and returns its status. */
  /**
   * `rebuild` asks for a build now even though no change was observed: the
   * manual escape hatch when automatic change detection is off.
   */
  lease(
    projectSlug: string,
    projectDir: string,
    { rebuild = false }: { rebuild?: boolean } = {},
  ): PluginDraftStatus {
    let root: string;
    try {
      root = realpathSync(projectDir);
    } catch {
      return unavailable(projectSlug, 'The Project folder does not exist.');
    }
    const draftId = pluginDraftId(root, projectSlug);
    const existing = this.entries.get(draftId);
    if (existing) {
      existing.expiresAt = this.now() + this.leaseTtlMs;
      if (rebuild) this.forceRebuild(existing);
      return this.statusOf(existing);
    }
    if (this.entries.size >= this.maxActiveLeases) {
      return unavailable(
        projectSlug,
        'Too many plugin drafts are being previewed on this Station right now. Close another preview and try again.',
      );
    }
    const entry: DraftEntry = {
      draftId,
      projectSlug,
      root,
      expiresAt: this.now() + this.leaseTtlMs,
      state: 'building',
      building: false,
      pending: false,
      released: false,
      diagnostics: [],
      panes: [],
      generations: [],
    };
    this.entries.set(draftId, entry);
    entry.watcher = this.watch({
      cwd: root,
      paths: [root],
      targets: ['.'],
      accepts: (relativePath) => {
        const segments = relativePath.split(/[\\/]/);
        if (
          segments.some(
            (segment) =>
              SKIPPED_SEGMENTS.has(segment) || segment.startsWith('.'),
          )
        )
          return false;
        return WATCHED_EXTENSIONS.has(extname(relativePath));
      },
      onChange: () => this.scheduleBuild(entry),
      debounceMs: this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      ...(this.options.pollIntervalMs
        ? { pollIntervalMs: this.options.pollIntervalMs }
        : {}),
    });
    this.scheduleBuild(entry);
    return this.statusOf(entry);
  }

  /** Status without starting anything: a Project with no lease reads `idle`. */
  status(projectSlug: string, projectDir: string): PluginDraftStatus {
    const entry = this.entryFor(projectSlug, projectDir);
    return entry ? this.statusOf(entry) : idleStatus(projectSlug);
  }

  /**
   * The built file for one retained revision of this Project's draft, or
   * undefined. Only a leased draft's retained generations are served.
   */
  bundleFile(
    projectSlug: string,
    projectDir: string,
    generation: number,
    digest: string,
    kind: 'js' | 'css',
  ): string | undefined {
    const entry = this.entryFor(projectSlug, projectDir);
    const retained = entry?.generations.find(
      (candidate) =>
        candidate.generation === generation && candidate.digest === digest,
    );
    if (!retained) return undefined;
    if (kind === 'css' && !retained.hasCss) return undefined;
    const file = join(retained.dir, kind === 'js' ? 'bundle.js' : 'bundle.css');
    return existsSync(file) ? file : undefined;
  }

  /** Waits until no build is running or queued for this Project (tests). */
  async idle(projectSlug: string, projectDir: string): Promise<void> {
    for (;;) {
      const entry = this.entryFor(projectSlug, projectDir);
      if (!entry || (!entry.building && !entry.pending)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  dispose(): void {
    clearInterval(this.sweep);
    for (const entry of [...this.entries.values()]) this.release(entry);
  }

  releaseExpired(): void {
    const now = this.now();
    for (const entry of [...this.entries.values()]) {
      if (entry.expiresAt <= now) this.release(entry);
    }
  }

  private entryFor(
    projectSlug: string,
    projectDir: string,
  ): DraftEntry | undefined {
    let root: string;
    try {
      root = realpathSync(projectDir);
    } catch {
      return undefined;
    }
    return this.entries.get(pluginDraftId(root, projectSlug));
  }

  private release(entry: DraftEntry): void {
    entry.released = true;
    entry.watcher?.close();
    this.entries.delete(entry.draftId);
    // A build still running finishes into a released entry and cleans up
    // after itself (see runBuild); removing the directory under it here
    // would race the esbuild write.
    if (!entry.building) this.removeDraftDir(entry);
  }

  private removeDraftDir(entry: DraftEntry): void {
    rmSync(join(this.options.draftsRoot, entry.draftId), {
      recursive: true,
      force: true,
    });
  }

  private statusOf(entry: DraftEntry): PluginDraftStatus {
    const latest = entry.generations.at(-1);
    return {
      projectSlug: entry.projectSlug,
      draftId: entry.draftId,
      state: entry.state,
      generation: latest?.generation ?? null,
      ...(latest
        ? {
            registrationKey: this.registrationKey(entry, latest.generation),
            digest: latest.digest,
          }
        : {}),
      hasCss: latest?.hasCss ?? false,
      ...(entry.pluginName ? { pluginName: entry.pluginName } : {}),
      ...(entry.pluginVersion ? { pluginVersion: entry.pluginVersion } : {}),
      panes: entry.panes,
      diagnostics: entry.diagnostics,
      ...watchState(entry.watcher),
      ...(latest ? { builtAt: latest.builtAt } : {}),
      leaseExpiresAt: new Date(entry.expiresAt).toISOString(),
    };
  }

  /**
   * A manual rebuild, bounded: ignored while a build for this draft is
   * running or queued (that build already reads the current files), and at
   * most one per {@link MIN_FORCED_REBUILD_INTERVAL_MS}. The caller gets the
   * current status either way.
   */
  private forceRebuild(entry: DraftEntry): void {
    if (entry.building || entry.pending) return;
    const now = this.now();
    if (
      entry.lastForcedRebuildAt !== undefined &&
      now - entry.lastForcedRebuildAt < MIN_FORCED_REBUILD_INTERVAL_MS
    )
      return;
    entry.lastForcedRebuildAt = now;
    this.scheduleBuild(entry);
  }

  private registrationKey(entry: DraftEntry, generation: number): string {
    return `${entry.draftId}:${this.lifetime}:${generation}`;
  }

  private scheduleBuild(entry: DraftEntry): void {
    if (entry.released) return;
    if (entry.building) {
      entry.pending = true;
      return;
    }
    entry.building = true;
    entry.pending = false;
    entry.state = 'building';
    const start = () => {
      this.activeBuilds += 1;
      void this.runBuild(entry).finally(() => {
        this.activeBuilds -= 1;
        entry.building = false;
        this.buildQueue.shift()?.();
        if (entry.released) {
          this.removeDraftDir(entry);
          return;
        }
        if (entry.pending) this.scheduleBuild(entry);
      });
    };
    if (this.activeBuilds < this.maxConcurrentBuilds) start();
    else this.buildQueue.push(start);
  }

  private async runBuild(entry: DraftEntry): Promise<void> {
    const manifestPath = join(entry.root, 'plugin.json');
    if (!existsSync(manifestPath)) {
      entry.state = 'no-manifest';
      entry.diagnostics = [];
      entry.panes = [];
      return;
    }
    let manifest: PluginManifest;
    try {
      // Read non-blocking and bounded: a FIFO named plugin.json must not
      // block a thread (the async fs pool has four) any more than a source
      // file may block esbuild.
      const raw = readBoundedRegularFileSync(manifestPath, MAX_MANIFEST_BYTES);
      if (raw === null) {
        throw new Error(
          'plugin.json is not a regular file of at most 1 MB, so it was not read.',
        );
      }
      manifest = parsePluginManifestDocumentWithFormat(
        raw,
        manifestPath,
      ).manifest;
    } catch (error) {
      entry.state = 'failed';
      entry.diagnostics = [
        {
          text: scrubRoot(
            error instanceof Error ? error.message : 'plugin.json is invalid.',
            entry.root,
          ),
          file: 'plugin.json',
        },
      ];
      return;
    }
    entry.pluginName = manifest.name;
    entry.pluginVersion = manifest.version;
    entry.panes = draftPanes(manifest);
    const previous = entry.generations.at(-1);
    const generation = (previous?.generation ?? 0) + 1;
    const dir = join(
      this.options.draftsRoot,
      entry.draftId,
      String(generation),
    );
    rmSync(dir, { recursive: true, force: true });
    let result: PluginDraftBuildResult;
    const controller = new AbortController();
    const timeoutMs = this.options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const build = this.build({
        pluginDir: entry.root,
        outdir: dir,
        registrationKey: this.registrationKey(entry, generation),
        manifest,
        signal: controller.signal,
      });
      // The build is raced, not just aborted: a build that ignores its
      // signal (blocked in a read) still gives its slot back at the deadline.
      build.catch(() => {});
      result = await Promise.race([
        build,
        new Promise<PluginDraftBuildResult>((resolveTimeout) => {
          deadline = setTimeout(() => {
            // Settle the race first, then abort: an aborted build resolves
            // with a generic "stopped" result synchronously, which would
            // otherwise win and hide why it was stopped.
            resolveTimeout({
              ok: false,
              diagnostics: [
                {
                  text: `The draft build did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped. Check for an import that never finishes reading (a pipe or device file).`,
                },
              ],
            });
            controller.abort();
          }, timeoutMs);
          deadline.unref?.();
        }),
      ]);
    } catch (error) {
      this.options.logger?.warn?.('Plugin draft build failed unexpectedly', {
        draftId: entry.draftId,
        error: error instanceof Error ? error.message : String(error),
      });
      result = {
        ok: false,
        diagnostics: [{ text: 'The draft build failed unexpectedly.' }],
      };
    } finally {
      if (deadline) clearTimeout(deadline);
    }
    if (!result.ok) {
      rmSync(dir, { recursive: true, force: true });
      entry.state = 'failed';
      entry.diagnostics = [...result.diagnostics];
      return;
    }
    const hasCss = Boolean(result.cssPath);
    const registrationKey = this.registrationKey(entry, generation);
    const digest = normalizedDigest(
      result.bundlePath,
      hasCss ? result.cssPath : undefined,
      registrationKey,
    );
    entry.diagnostics = [...(result.warnings ?? [])];
    entry.state = 'ready';
    // A save that changed nothing the bundle depends on is not a revision.
    // The registration key embeds the generation, so bytes are compared with
    // the key normalized out.
    if (previous && previous.digest === digest) {
      rmSync(dir, { recursive: true, force: true });
      return;
    }
    const retained: DraftGeneration = {
      generation,
      dir,
      hasCss,
      digest,
      builtAt: new Date(this.now()).toISOString(),
    };
    entry.generations.push(retained);
    for (const dropped of entry.generations.splice(
      0,
      Math.max(0, entry.generations.length - RETAINED_GENERATIONS),
    )) {
      rmSync(dropped.dir, { recursive: true, force: true });
    }
    if (entry.released) return;
    this.options.emitRebuilt({
      projectSlug: entry.projectSlug,
      draftId: entry.draftId,
      generation,
    });
  }
}

/**
 * Whether this folder's edits rebuild on their own, derived from what the
 * watcher reports rather than assumed: native events armed, or the polling
 * fallback running. When polling is off its reason is carried, so the pane
 * can say automatic rebuilds may not happen and offer a manual one.
 */
function watchState(
  watcher: WatchHandle | undefined,
): Pick<PluginDraftStatus, 'watch'> {
  if (!watcher) return {};
  const status = watcher.status();
  return {
    watch: {
      native: status.nativeArmed,
      polling: status.pollingActive,
      ...(status.pollingActive
        ? {}
        : {
            reason:
              status.pollingError ??
              status.nativeError ??
              'change detection is unavailable',
          }),
    },
  };
}

function normalizedDigest(
  bundlePath: string,
  cssPath: string | undefined,
  registrationKey: string,
): string {
  const js = readFileSync(bundlePath, 'utf8').split(
    JSON.stringify(registrationKey),
  );
  return createHash('sha256')
    .update(js.join('"<key>"'))
    .update('\0')
    .update(cssPath ? readFileSync(cssPath) : '')
    .digest('hex')
    .slice(0, 32);
}

function scrubRoot(text: string, root: string): string {
  return text
    .split(root + sep)
    .join('')
    .split(root)
    .join('.');
}

function draftPanes(manifest: PluginManifest): PluginDraftPane[] {
  const panes: PluginDraftPane[] = [];
  for (const pane of manifest.workspacePanes ?? []) {
    if (pane.renderer.kind !== 'plugin-component') continue;
    panes.push({ id: pane.id, name: pane.name, component: pane.renderer.name });
  }
  return panes;
}
