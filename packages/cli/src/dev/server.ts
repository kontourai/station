import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { buildPlugin } from '@kontourai/station-shared/build';
import {
  INVOKED_CWD,
  lookupDepInRegistries,
  PLUGINS_DIR,
  readManifest,
} from '../commands/helpers.js';
import { install } from '../commands/install.js';
import { ensureDevAssetBundles } from './bundles.js';
import { createDevHttpServer } from './http.js';
import { setupDevMcpManager } from './mcp.js';
import { regenerateDevHTML } from './registry.js';
import { DEV_SERVER_HOST } from './security.js';
import {
  describeWatchStatus,
  fallbackNotice,
  watchConfigChanges,
  watchSourceChanges,
} from './watchers.js';

export interface DevFlags {
  mcp?: boolean;
  toolsDir?: string;
}

export async function listenDevServer(
  server: Server,
  port: number,
): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, DEV_SERVER_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Dev server did not bind a TCP address');
  return address;
}

export function devServerOrigin(address: AddressInfo): string {
  return `http://${address.address}:${address.port}`;
}

export async function startDevServer(
  port: number,
  flags: DevFlags = {},
): Promise<void> {
  await buildPlugin(INVOKED_CWD, 'dev');

  const manifest = readManifest(INVOKED_CWD);

  // Resolve dependencies (install if missing, same as `station plugin install`)
  if (manifest.dependencies?.length) {
    for (const dep of manifest.dependencies) {
      if (existsSync(join(PLUGINS_DIR, dep.id, 'plugin.json'))) continue;
      const depSource = dep.source || lookupDepInRegistries(dep.id);
      if (depSource) {
        console.log(`📦 Installing dependency: ${dep.id}...`);
        try {
          install(depSource, []);
        } catch (e: any) {
          console.warn(`  ⚠ Dep ${dep.id} failed: ${e.message}`);
        }
      }
    }
  }

  const name = manifest.displayName || manifest.name;
  const { bundleJs, bundleCss, bundleCssFallback, reactBundle, sdkBundle } =
    ensureDevAssetBundles(INVOKED_CWD);

  const layoutPath = manifest.layout?.source
    ? join(INVOKED_CWD, manifest.layout.source)
    : null;
  let { html, layout } = regenerateDevHTML({
    cwd: INVOKED_CWD,
    manifest,
    layoutPath,
    pluginsDir: PLUGINS_DIR,
  });

  // ── MCP setup ──
  let mcpManager: any = null;
  const useMCP = flags.mcp !== false;
  const toolsDir = flags.toolsDir || join(INVOKED_CWD, 'integrations');

  if (useMCP && manifest.agents?.length) {
    (async () => {
      try {
        mcpManager = await setupDevMcpManager({
          cwd: INVOKED_CWD,
          toolsDir,
        });
      } catch (err: any) {
        console.warn(`   ⚠ MCP setup failed: ${err.message}`);
      }
    })();
  }

  // ── Hot reload ──
  const { close, reloadClients, server } = createDevHttpServer({
    cwd: INVOKED_CWD,
    pluginsDir: PLUGINS_DIR,
    bundleJs,
    bundleCss,
    bundleCssFallback,
    reactBundle,
    sdkBundle,
    getHtml: () => html,
    getMcpManager: () => mcpManager,
  });

  // Said at most once, the first time the polling fallback is what noticed a
  // change — see `fallbackNotice`.
  let fallbackAnnounced = false;
  const announceFallbackOnce = () => {
    if (fallbackAnnounced) return;
    const notice = fallbackNotice([sourceWatch, configWatch]);
    if (!notice) return;
    fallbackAnnounced = true;
    console.log(notice);
  };

  const sourceWatch = watchSourceChanges({
    cwd: INVOKED_CWD,
    onRebuild: async (filename) => {
      try {
        announceFallbackOnce();
        console.log(`\n♻️  ${filename} changed — rebuilding...`);
        await buildPlugin(INVOKED_CWD, 'dev');
        for (const res of reloadClients) {
          res.write('data: reload\n\n');
        }
      } catch (err: any) {
        console.error(`   Build failed: ${err.message}`);
      }
    },
  });

  const configWatch = watchConfigChanges({
    cwd: INVOKED_CWD,
    manifest,
    layoutPath,
    onReload: (label) => {
      try {
        announceFallbackOnce();
        console.log(`\n♻️  ${label} changed — regenerating config...`);
        ({ html, layout } = regenerateDevHTML({
          cwd: INVOKED_CWD,
          manifest,
          layoutPath,
          pluginsDir: PLUGINS_DIR,
        }));
        for (const res of reloadClients) {
          res.write('data: reload\n\n');
        }
      } catch (err: any) {
        console.error(`   Config reload failed: ${err.message}`);
      }
    },
  });

  const address = await listenDevServer(server, port);
  {
    const tabs = layout?.tabs || [];
    console.log(
      `\n🔧 Plugin dev server running at ${devServerOrigin(address)}`,
    );
    console.log(`   Plugin: ${name}`);
    console.log(`   Tabs: ${tabs.map((t) => t.label).join(', ') || 'none'}`);
    console.log(
      useMCP && manifest.agents?.length
        ? '   MCP: connecting...'
        : '   MCP: off',
    );
    for (const line of describeWatchStatus([sourceWatch, configWatch])) {
      console.log(line);
    }
    console.log('');
  }

  const cleanup = async () => {
    sourceWatch.close();
    configWatch.close();
    if (mcpManager) await mcpManager.closeAll();
    await close();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
