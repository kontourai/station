import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type {
  PluginManifest,
  PluginOperationalEventObserver,
  PluginReviewedSourcesModule,
  ReviewedSourcesInvocation,
  ReviewedSourcesResult,
} from '@kontourai/station-contracts/plugin';
import type { Context, Hono as HonoType } from 'hono';
import { ConfigLoader } from '../../domain/config-loader.js';
import { readPluginManifestFile } from '../../services/plugins/plugin-manifest-loader.js';
import type { Logger } from '../../utils/logger.js';
import {
  assertExistingPathInside,
  assertPathInside,
} from '../../utils/path-containment.js';
import { assertPluginNameSegment } from './plugin-install-shared.js';

export interface PluginServerRequestContext {
  correlationId: string;
  method: string;
  path: string;
  pluginName: string;
  startedAt: number;
}

export interface PluginServerHooks {
  onError?: (
    context: PluginServerRequestContext & { error: unknown },
  ) => void | Promise<void>;
  onRequest?: (context: PluginServerRequestContext) => void | Promise<void>;
  onResponse?: (
    context: PluginServerRequestContext & { status: number },
  ) => void | Promise<void>;
}

export interface PluginServerModuleContext {
  config: {
    all: () => Record<string, unknown>;
    get: (key: string) => unknown;
  };
  logger: Logger;
  pluginName: string;
  projectHomeDir: string;
  telemetry: {
    recordRoutingDecision: (
      attributes: Record<string, string | number | boolean>,
    ) => void;
  };
}

export interface LoadedPluginServerModule {
  dispose?: () => void | Promise<void>;
  hooks?: PluginServerHooks;
  operationalEvents?: PluginOperationalEventObserver;
  /**
   * Optional owner resolver used only by Station's reviewed-sources seam.
   * It is acquired under this module's normal grant and lifecycle lease.
   */
  reviewedSources?: PluginReviewedSourcesModule;
  register: (
    app: HonoType,
    context: PluginServerModuleContext,
  ) => void | Promise<void>;
}

interface CachedPluginServerModule {
  activeRequests: number;
  drain?: Promise<void>;
  resolveDrain?: () => void;
  loaded: LoadedPluginServerModule;
  moduleUrl: string;
}

const loadedPluginServerModules = new Map<string, CachedPluginServerModule>();
const pluginServerLifecycleLocks = new Map<string, Promise<void>>();
const pluginServerQuiescence = new Map<string, number>();
const pluginServerModuleGenerations = new Map<string, number>();
let globalPluginServerQuiescence = 0;
let activePluginServerAcquisitions = 0;
let pluginServerAcquisitionDrain: Promise<void> | undefined;
let resolvePluginServerAcquisitionDrain: (() => void) | undefined;

function pluginServerModuleKey(pluginsDir: string, pluginName: string): string {
  return join(pluginsDir, pluginName);
}

async function withPluginServerLifecycleLock<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const prior = pluginServerLifecycleLocks.get(key) ?? Promise.resolve();
  let releaseLock: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const tail = prior.catch(() => undefined).then(() => current);
  pluginServerLifecycleLocks.set(key, tail);
  await prior.catch(() => undefined);
  try {
    return await operation();
  } finally {
    releaseLock?.();
    if (pluginServerLifecycleLocks.get(key) === tail) {
      pluginServerLifecycleLocks.delete(key);
    }
  }
}

async function waitForPluginServerRequests(
  cached: CachedPluginServerModule,
): Promise<void> {
  if (cached.activeRequests === 0) return;
  cached.drain ??= new Promise<void>((resolve) => {
    cached.resolveDrain = resolve;
  });
  await cached.drain;
}

async function waitForPluginServerAcquisitions(): Promise<void> {
  if (activePluginServerAcquisitions === 0) return;
  pluginServerAcquisitionDrain ??= new Promise<void>((resolve) => {
    resolvePluginServerAcquisitionDrain = resolve;
  });
  await pluginServerAcquisitionDrain;
}

function releasePluginServerAcquisition(): void {
  activePluginServerAcquisitions -= 1;
  if (activePluginServerAcquisitions === 0) {
    resolvePluginServerAcquisitionDrain?.();
    resolvePluginServerAcquisitionDrain = undefined;
    pluginServerAcquisitionDrain = undefined;
  }
}

async function disposeCachedPluginServerModule(
  key: string,
  expected?: CachedPluginServerModule,
): Promise<void> {
  const cached = loadedPluginServerModules.get(key);
  if (!cached || (expected && cached !== expected)) return;
  await waitForPluginServerRequests(cached);
  await cached.loaded.dispose?.();
  if (loadedPluginServerModules.get(key) === cached) {
    loadedPluginServerModules.delete(key);
    pluginServerModuleGenerations.set(
      key,
      (pluginServerModuleGenerations.get(key) ?? 0) + 1,
    );
  }
}

/**
 * A revocation fence is advanced before waiting for any caller that already
 * holds a lease.  Awaiting the drain first would let a late owner read publish
 * after its grant was withdrawn.
 */
function invalidatePluginServerModuleGeneration(key: string): void {
  pluginServerModuleGenerations.set(
    key,
    (pluginServerModuleGenerations.get(key) ?? 0) + 1,
  );
}

export interface PluginPublicServerQuiescence {
  release: () => void;
}

export async function quiescePluginPublicServerModule(
  pluginsDir: string,
  pluginName: string,
): Promise<PluginPublicServerQuiescence> {
  assertPluginNameSegment(pluginName);
  const key = pluginServerModuleKey(pluginsDir, pluginName);
  await withPluginServerLifecycleLock(key, async () => {
    pluginServerQuiescence.set(key, (pluginServerQuiescence.get(key) ?? 0) + 1);
    invalidatePluginServerModuleGeneration(key);
    try {
      await disposeCachedPluginServerModule(key);
    } catch (error) {
      const remaining = (pluginServerQuiescence.get(key) ?? 1) - 1;
      if (remaining === 0) pluginServerQuiescence.delete(key);
      else pluginServerQuiescence.set(key, remaining);
      throw error;
    }
  });
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      const remaining = (pluginServerQuiescence.get(key) ?? 1) - 1;
      if (remaining === 0) pluginServerQuiescence.delete(key);
      else pluginServerQuiescence.set(key, remaining);
    },
  };
}

export async function quiesceAllPluginPublicServerModules(): Promise<PluginPublicServerQuiescence> {
  const guards: PluginPublicServerQuiescence[] = [];
  globalPluginServerQuiescence += 1;
  try {
    await waitForPluginServerAcquisitions();
    for (const key of [...loadedPluginServerModules.keys()]) {
      const pluginName = basename(key);
      const pluginsDir = dirname(key);
      guards.push(
        await quiescePluginPublicServerModule(pluginsDir, pluginName),
      );
    }
  } catch (error) {
    for (const guard of guards.reverse()) guard.release();
    globalPluginServerQuiescence -= 1;
    throw error;
  }
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      for (const guard of guards.reverse()) guard.release();
      globalPluginServerQuiescence -= 1;
    },
  };
}

export async function disposePluginPublicServerModule(
  pluginsDir: string,
  pluginName: string,
): Promise<void> {
  const quiescence = await quiescePluginPublicServerModule(
    pluginsDir,
    pluginName,
  );
  quiescence.release();
}

export async function disposeAllPluginPublicServerModules(): Promise<void> {
  globalPluginServerQuiescence += 1;
  const failures: unknown[] = [];
  await waitForPluginServerAcquisitions();
  for (const [key, cached] of [...loadedPluginServerModules]) {
    try {
      await withPluginServerLifecycleLock(key, async () => {
        pluginServerQuiescence.set(
          key,
          (pluginServerQuiescence.get(key) ?? 0) + 1,
        );
        await disposeCachedPluginServerModule(key, cached);
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'Plugin server module disposal was incomplete.',
    );
  }
}

export function buildPluginRequestContext(
  c: Context,
  pluginName: string,
): PluginServerRequestContext {
  return {
    correlationId:
      c.req.header('x-station-correlation-id') ||
      c.req.header('x-request-id') ||
      randomUUID(),
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    pluginName,
    startedAt: Date.now(),
  };
}

export function createScopedPluginRequest(
  c: Context,
  pluginName: string,
): Request {
  const url = new URL(c.req.url);
  const prefixes = [
    `/api/plugins/${encodeURIComponent(pluginName)}`,
    `/${encodeURIComponent(pluginName)}`,
  ];
  const matchedPrefix = prefixes.find((prefix) =>
    url.pathname.startsWith(prefix),
  );
  url.pathname = matchedPrefix
    ? url.pathname.slice(matchedPrefix.length) || '/'
    : '/';
  return new Request(url, c.req.raw.clone());
}

export async function readPluginPublicManifest(
  pluginsDir: string,
  pluginName: string,
): Promise<PluginManifest | null> {
  assertPluginNameSegment(pluginName);
  const manifestPath = join(pluginsDir, pluginName, 'plugin.json');
  assertPathInside(pluginsDir, manifestPath, 'Plugin public manifest');
  if (!existsSync(manifestPath)) return null;
  return readPluginManifestFile(manifestPath);
}

export async function readPluginServerSettings(
  projectHomeDir: string,
  pluginName: string,
  manifest: PluginManifest,
): Promise<Record<string, unknown>> {
  const configLoader = new ConfigLoader({ projectHomeDir });
  const overrides = await configLoader.loadPluginOverrides();
  const values = overrides[pluginName]?.settings || {};
  // Null-prototype, exactly as `GET /:name/settings` does
  // (`plugin-config-routes.ts`) and for a sharper reason: this map is handed
  // to a plugin's server module as `config.get`/`config.all`
  // (`plugin-public-routes.ts`). BOTH loops below write keys nobody on this
  // side chose — `field.key` is manifest-author-controlled and the second loop
  // copies every persisted key verbatim — so on a plain accumulator a
  // `__proto__` key REPARENTED `merged` instead of landing on it: `config.get`
  // then answered attacker-supplied values for keys nobody set while
  // `config.all()` showed no such key, and the two disagreed (archive#4307
  // review). The manifest side is also refused at parse
  // (`plugin-manifest-loader.ts`); this is the store-shaped half of the fix.
  const merged: Record<string, unknown> = Object.create(null);
  for (const field of manifest.settings || []) {
    merged[field.key] = values[field.key] ?? field.default ?? null;
  }
  for (const [key, value] of Object.entries(values)) {
    merged[key] = value;
  }
  return merged;
}

export async function loadPluginPublicServerModule(
  pluginsDir: string,
  pluginName: string,
  manifest: PluginManifest,
  logger: Logger,
): Promise<LoadedPluginServerModule | null> {
  const acquired = await acquirePluginPublicServerModule(
    pluginsDir,
    pluginName,
    manifest,
    logger,
  );
  acquired?.release();
  return acquired?.loaded ?? null;
}

export interface AcquiredPluginPublicServerModule {
  loaded: LoadedPluginServerModule;
  /** Revocation starts by invalidating this witness, before lease drain. */
  isCurrent: () => boolean;
  release: () => void;
}

/**
 * Acquire a reviewed-source owner under the exact same trusted-module lease as
 * a public plugin route. The caller owns manifest/grant authorization; this
 * adapter owns generation fencing before and after every owner await.
 */
export async function acquirePluginReviewedSourcesModule(input: {
  pluginsDir: string;
  pluginName: string;
  manifest: PluginManifest;
  logger: Logger;
  projectHomeDir: string;
}): Promise<{
  read(input: ReviewedSourcesInvocation): Promise<ReviewedSourcesResult>;
  release(): void;
} | null> {
  const acquired = await acquirePluginPublicServerModule(
    input.pluginsDir,
    input.pluginName,
    input.manifest,
    input.logger,
  );
  if (!acquired) return null;
  const owner = acquired.loaded.reviewedSources;
  if (!owner) {
    acquired.release();
    return null;
  }
  let released = false;
  return {
    async read(invocation) {
      if (
        released ||
        invocation.pluginName !== input.pluginName ||
        !acquired.isCurrent()
      )
        return { version: 'station.reviewed-sources/v1', status: 'restricted' };
      try {
        const result = await owner.readReviewedSource(invocation, {
          projectHomeDir: input.projectHomeDir,
        });
        return acquired.isCurrent()
          ? result
          : { version: 'station.reviewed-sources/v1', status: 'restricted' };
      } catch {
        return acquired.isCurrent()
          ? { version: 'station.reviewed-sources/v1', status: 'unavailable' }
          : { version: 'station.reviewed-sources/v1', status: 'restricted' };
      }
    },
    release() {
      if (released) return;
      released = true;
      acquired.release();
    },
  };
}

export async function acquirePluginPublicServerModule(
  pluginsDir: string,
  pluginName: string,
  manifest: PluginManifest,
  logger: Logger,
): Promise<AcquiredPluginPublicServerModule | null> {
  if (!manifest.serverModule) return null;
  const serverModulePath = manifest.serverModule;
  assertPluginNameSegment(pluginName);
  if (globalPluginServerQuiescence > 0) {
    throw new Error('Plugin server modules are globally quiescing');
  }
  activePluginServerAcquisitions += 1;
  const cacheKey = pluginServerModuleKey(pluginsDir, pluginName);
  try {
    return await withPluginServerLifecycleLock(cacheKey, async () => {
      if ((pluginServerQuiescence.get(cacheKey) ?? 0) > 0) {
        throw new Error(`Plugin server module '${pluginName}' is quiescing`);
      }
      const pluginRoot = join(pluginsDir, pluginName);
      const modulePath = join(pluginRoot, serverModulePath);
      assertExistingPathInside(pluginRoot, modulePath, 'Plugin server module');
      if (!existsSync(modulePath)) {
        logger.warn('Plugin serverModule missing', {
          modulePath,
          plugin: pluginName,
        });
        return null;
      }

      const generation = pluginServerModuleGenerations.get(cacheKey) ?? 0;
      const moduleUrl = `file://${modulePath}?mtime=${statSync(modulePath).mtimeMs}&generation=${generation}`;
      let cached = loadedPluginServerModules.get(cacheKey);
      if (cached?.moduleUrl !== moduleUrl) {
        if (cached) await disposeCachedPluginServerModule(cacheKey, cached);
        const imported = await import(moduleUrl);
        const candidate = imported.default || imported;
        const hooks = (candidate?.hooks || imported.hooks) as
          | PluginServerHooks
          | undefined;
        const operationalEvents = (candidate?.operationalEvents ||
          imported.operationalEvents) as
          | PluginOperationalEventObserver
          | undefined;
        const reviewedSources = (candidate?.reviewedSources ||
          imported.reviewedSources) as PluginReviewedSourcesModule | undefined;
        const dispose =
          typeof candidate?.dispose === 'function'
            ? candidate.dispose.bind(candidate)
            : typeof imported.dispose === 'function'
              ? imported.dispose.bind(imported)
              : undefined;
        const register =
          typeof candidate === 'function'
            ? candidate
            : typeof candidate?.register === 'function'
              ? candidate.register.bind(candidate)
              : typeof imported.register === 'function'
                ? imported.register.bind(imported)
                : null;

        if (!register) {
          logger.warn('Plugin serverModule missing register function', {
            modulePath,
            plugin: pluginName,
          });
          return null;
        }

        cached = {
          activeRequests: 0,
          loaded: {
            dispose,
            hooks,
            operationalEvents,
            reviewedSources,
            register,
          },
          moduleUrl,
        };
        loadedPluginServerModules.set(cacheKey, cached);
      }

      cached.activeRequests += 1;
      let released = false;
      return {
        loaded: cached.loaded,
        isCurrent() {
          return (
            globalPluginServerQuiescence === 0 &&
            (pluginServerQuiescence.get(cacheKey) ?? 0) === 0 &&
            (pluginServerModuleGenerations.get(cacheKey) ?? 0) === generation
          );
        },
        release() {
          if (released) return;
          released = true;
          cached.activeRequests -= 1;
          if (cached.activeRequests === 0) {
            cached.resolveDrain?.();
            cached.resolveDrain = undefined;
            cached.drain = undefined;
          }
        },
      };
    });
  } finally {
    releasePluginServerAcquisition();
  }
}
