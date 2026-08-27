import { Hono } from 'hono';
import {
  bootPayloadSectionErrors,
  bootPayloadServed,
} from '../../telemetry/metrics.js';

export const BOOT_PAYLOAD_VERSION = 1;

export interface BootPayloadProviders {
  auth: () => Promise<unknown>;
  config: () => Promise<unknown>;
  capabilities: () => Promise<unknown>;
  branding: () => Promise<unknown>;
  agents: () => Promise<unknown>;
  projects: () => Promise<unknown>;
  models: () => Promise<unknown>;
}

/** A best-effort, cache-seeding read: no individual section can block boot. */
export function createBootRoutes(providers: BootPayloadProviders) {
  const app = new Hono();
  app.get('/', async (c) => {
    const entries = await Promise.all(
      Object.entries(providers).map(async ([name, read]) => {
        try {
          return [name, { data: await read() }] as const;
        } catch {
          bootPayloadSectionErrors.add(1, { section: name });
          return [name, { error: true }] as const;
        }
      }),
    );
    bootPayloadServed.add(1);
    return c.json({
      version: BOOT_PAYLOAD_VERSION,
      sections: Object.fromEntries(entries),
    });
  });
  return app;
}
