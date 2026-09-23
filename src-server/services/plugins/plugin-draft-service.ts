import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import {
  PLUGIN_DRAFT_LEASE_TTL_MS,
  type PluginDraftDiagnostic,
  type PluginDraftPane,
  type PluginDraftStatus,
} from '@kontourai/station-contracts/plugin-draft';
import {
  buildPluginDraft,
  type PluginDraftBuildOptions,
  type PluginDraftBuildResult,
} from '@kontourai/station-shared/build';
import {
  type FallbackWatchOptions,
  type WatchHandle,
  watchWithFallback,
} from '@kontourai/station-shared/source-watch';
import { readPluginManifestFileWithFormat } from './plugin-manifest-loader.js';

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
  return { ...idleStatus(projectSlug), state: 'unavailable', diagnostics: [{ text }] };
}

export class PluginDraftService {
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
    this.build = options.build ?? buildPluginDraft;
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
  lease(projectSlug: string, projectDir: string): PluginDraftStatus {
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
            (segment) => SKIPPED_SEGMENTS.has(segment) || segment.startsWith('.'),
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
    kind: 'js' | 'css',
  ): string | undefined {
    const entry = this.entryFor(projectSlug, projectDir);
    const retained = entry?.generations.find(
      (candidate) => candidate.generation === generation,
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
        ? { registrationKey: `${entry.draftId}:${latest.generation}` }
        : {}),
      hasCss: latest?.hasCss ?? false,
      ...(entry.pluginName ? { pluginName: entry.pluginName } : {}),
      ...(entry.pluginVersion ? { pluginVersion: entry.pluginVersion } : {}),
      panes: entry.panes,
      diagnostics: entry.diagnostics,
      ...(latest ? { builtAt: latest.builtAt } : {}),
      leaseExpiresAt: new Date(entry.expiresAt).toISOString(),
    };
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
      manifest = (await readPluginManifestFileWithFormat(manifestPath))
        .manifest;
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
    const dir = join(this.options.draftsRoot, entry.draftId, String(generation));
    rmSync(dir, { recursive: true, force: true });
    let result: PluginDraftBuildResult;
    try {
      result = await this.build({
        pluginDir: entry.root,
        outdir: dir,
        registrationKey: `${entry.draftId}:${generation}`,
        manifest,
      });
    } catch (error) {
      this.options.logger?.warn?.('Plugin draft build failed unexpectedly', {
        draftId: entry.draftId,
        error: error instanceof Error ? error.message : String(error),
      });
      result = {
        ok: false,
        diagnostics: [{ text: 'The draft build failed unexpectedly.' }],
      };
    }
    if (!result.ok) {
      rmSync(dir, { recursive: true, force: true });
      entry.state = 'failed';
      entry.diagnostics = [...result.diagnostics];
      return;
    }
    const hasCss = Boolean(result.cssPath);
    const registrationKey = `${entry.draftId}:${generation}`;
    const digest = normalizedDigest(
      result.bundlePath,
      hasCss ? result.cssPath : undefined,
      registrationKey,
    );
    entry.diagnostics = [];
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
    .digest('hex');
}

function scrubRoot(text: string, root: string): string {
  return text.split(root + sep).join('').split(root).join('.');
}

function draftPanes(manifest: PluginManifest): PluginDraftPane[] {
  const panes: PluginDraftPane[] = [];
  for (const pane of manifest.workspacePanes ?? []) {
    if (pane.renderer.kind !== 'plugin-component') continue;
    panes.push({ id: pane.id, name: pane.name, component: pane.renderer.name });
  }
  return panes;
}
