import {
  MEDIA_UPLOAD_POLICIES,
  mediaUploadPolicy,
} from '@kontourai/station-contracts/walkthrough';
import { configureHttpReceive } from '@kontourai/station-shared/http-upload';
/**
 * VoltAgent's Hono surface mutates Zod's object helpers while loading its
 * vendored OpenAPI adapter. MCP builds its auth schemas with those helpers, so
 * MCP must initialize first. Keep that compatibility ordering at this one
 * production seam; runtime callers only need VoltAgent's narrow Hono interface.
 */
import '@modelcontextprotocol/server';

import type { Server as HttpServer } from 'node:http';
import { createAdaptorServer } from '@hono/node-server';
import type { IServerProvider, ServerProviderFactory } from '@voltagent/core';
import {
  createVoltAgentApp,
  type HonoServerConfig,
} from '@voltagent/server-hono';
import type { LanDiscovery } from '../../services/connections/lan-discovery.js';
import {
  closeStableListener,
  type ListenerLink,
  listenerLink,
} from '../bootstrap/supervisor-link.js';

export type { HonoServerConfig } from '@voltagent/server-hono';

/**
 * Station's API server provider. It builds the same app VoltAgent's own Hono
 * provider builds (`createVoltAgentApp`) but binds through the listener link,
 * so a supervised generation can listen on the API socket its supervisor
 * holds. VoltAgent's provider cannot: it probe-binds the port first and
 * refuses one that is in use. Station disables the framework WebSocket, and
 * the provider's startup banner and announcements are console output only.
 */
export function stationHonoServer(
  config: HonoServerConfig & { port: number },
  link: () => ListenerLink = listenerLink,
  discovery?: LanDiscovery,
): ServerProviderFactory {
  return (deps): IServerProvider => {
    let server: HttpServer | null = null;
    let running = false;
    return {
      isRunning: () => running,
      async start() {
        if (running) throw new Error('Server is already running');
        const { app } = await createVoltAgentApp(deps, config, config.port);
        const hostname = config.hostname || '0.0.0.0';
        const next = createAdaptorServer({
          fetch: app.fetch.bind(app),
          // The request URL's host when a request names none (HTTP/1.0
          // without Host), as VoltAgent's own provider passes it.
          hostname,
        }) as HttpServer;
        configureHttpReceive(
          next,
          (method, path) =>
            mediaUploadPolicy(method, path, MEDIA_UPLOAD_POLICIES),
          MEDIA_UPLOAD_POLICIES.walkthrough.totalMs,
        );
        const { port } = await link().listen('api', next, {
          port: config.port,
          host: hostname,
        });
        server = next;
        running = true;
        await discovery?.bound(next);
        return { port };
      },
      async stop() {
        if (!running) return;
        running = false;
        await discovery?.stop();
        const stopping = server;
        server = null;
        // Not awaited, as with VoltAgent's provider: open streams must not
        // hold shutdown until their clients leave.
        if (stopping) void closeStableListener(stopping);
      },
    };
  };
}
