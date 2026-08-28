/**
 * Plugin shared-module runtime bridge.
 *
 * Dynamically loaded plugin bundles are built with these packages marked
 * external; their `require` shim resolves them from
 * `window.__station_ai_shared` at load time (see `packages/shared/src/build.ts`).
 *
 * The bridge is split in two on purpose:
 *
 * - `installPluginSharedRuntime` publishes React, React Query and `debug`
 *   eagerly. It is synchronous, so anything reading
 *   `window.__station_ai_shared` right after boot sees those immediately. They
 *   stay here because the app genuinely ships them in the first-paint bundle,
 *   so publishing the same live namespace costs nothing.
 * - `ensurePluginSharedRuntimeReady` fills in everything a plugin needs that
 *   first paint does not — the SDK barrel namespace and `UserDetailModal`
 *   alongside the SDK client, voice SDK, `zod`, and `dompurify`. They are
 *   fetched on demand and awaited by `PluginRegistry` before the first plugin
 *   bundle is injected, so no plugin can observe the deferral: the `require`
 *   shim only runs once a bundle executes, which is strictly after that await.
 *
 * The SDK moved to the on-demand half in archive#883/#2751, and that IS a
 * plugin-API change rather than a silent optimization — hence the readiness
 * handle below. `import * as SDK` materializes the *whole* barrel namespace, so
 * every export was live whether or not the app imported it: 43 SDK modules the
 * app never reaches (scheduler, skills, taskGraph, sshEnvironments,
 * veritasReadiness, trustBundles, KnowledgeRecall, …) were pinned into the
 * entry chunk instead of landing in the lazy view chunks that actually use
 * them. `UserDetailModal` had the same shape — its only other importer is the
 * lazily-loaded `ProfilePage`. The app's own named SDK imports are unaffected
 * and still tree-shake normally; only the bridge's namespace materialization
 * moved.
 *
 * What a caller must now do: anything reading a shared module from the page
 * itself — rather than from inside a plugin bundle — awaits
 * `window.__station_ai_shared_ready` first. That handle is the contract; a
 * bare synchronous read of `__station_ai_shared['@kontourai/station-sdk']` is
 * no longer guaranteed, because with no plugins installed nothing else would
 * ever trigger the load.
 */

import * as ReactQuery from '@tanstack/react-query';
import debug from 'debug';
import * as ReactAll from 'react';
import * as jsxRuntime from 'react/jsx-runtime';

type SharedModules = Record<string, unknown>;

function sharedModules(): SharedModules {
  const globalScope = window as unknown as {
    __station_ai_shared?: SharedModules;
  };
  globalScope.__station_ai_shared ??= {};
  return globalScope.__station_ai_shared;
}

/** Publish the always-bundled shared modules. Safe to call more than once. */
export function installPluginSharedRuntime(): void {
  const shared = sharedModules();
  shared.react = ReactAll;
  shared['react/jsx-runtime'] = jsxRuntime;
  shared['react/jsx-dev-runtime'] = jsxRuntime;
  shared['@tanstack/react-query'] = ReactQuery;
  shared.debug = Object.assign(debug, { default: debug, __esModule: true });

  const globalScope = window as unknown as {
    __station_ai_plugins?: Record<string, unknown>;
    __station_ai_shared_ready?: () => Promise<void>;
  };
  globalScope.__station_ai_plugins ??= {};
  // Published synchronously so a page-level caller has something to await even
  // on a Station with no plugins installed, where nothing else would ever
  // trigger the on-demand load.
  globalScope.__station_ai_shared_ready ??= () =>
    ensurePluginSharedRuntimeReady();
}

let onDemandModules: Promise<void> | null = null;

/** Keep the optional voice chunk behind one loader for app and plugin callers. */
export const loadStationVoiceSdk = () => import('@kontourai/station-sdk/voice');

/** Keep the React-free SDK client out of the entry chunk until a plugin needs it. */
export const loadStationSdkClient = () =>
  import('@kontourai/station-sdk/client');

/**
 * Resolve the shared modules first paint does not need (the SDK barrel and
 * `UserDetailModal`, plus the SDK client, voice SDK, `zod`, `dompurify`) into
 * the bridge. Idempotent and memoized — call it before injecting any plugin
 * bundle, or via `window.__station_ai_shared_ready` from the page.
 */
export function ensurePluginSharedRuntimeReady(): Promise<void> {
  onDemandModules ??= (async () => {
    const [sdk, components, sdkClient, voiceSdk, zod, dompurify] =
      await Promise.all([
        import('@kontourai/station-sdk'),
        import('../components/modals/UserDetailModal'),
        loadStationSdkClient(),
        loadStationVoiceSdk(),
        import('zod/v3'),
        import('dompurify'),
      ]);
    const DOMPurify = dompurify.default;
    const shared = sharedModules();
    shared['@kontourai/station-sdk'] = sdk;
    shared['@kontourai/station-components'] = {
      UserDetailModal: components.UserDetailModal,
    };
    shared['@kontourai/station-sdk/client'] = sdkClient;
    shared['@kontourai/station-sdk/voice'] = voiceSdk;
    shared.zod = zod;
    // Plugins call `require('dompurify')` as a function *and* reach for its
    // named members, so the bridge value keeps both shapes.
    shared.dompurify = Object.assign(
      (dirty: string, cfg?: Parameters<typeof DOMPurify.sanitize>[1]) =>
        DOMPurify.sanitize(dirty, cfg),
      {
        ...DOMPurify,
        default: DOMPurify,
        __esModule: true,
      },
    );
  })().catch((error) => {
    // A failed fetch must not poison the memo — a later plugin load retries.
    onDemandModules = null;
    throw error;
  });
  return onDemandModules;
}
