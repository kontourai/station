import { type Context, Hono } from 'hono';
import {
  bootPayloadSectionErrors,
  bootPayloadServed,
} from '../../telemetry/metrics.js';

const BOOT_PAYLOAD_VERSION = 1;

/** Each provider receives the boot request, so a section can answer per caller. */
type BootSection = (c: Context) => Promise<unknown>;

export interface BootPayloadProviders {
  auth: BootSection;
  config: BootSection;
  capabilities: BootSection;
  branding: BootSection;
  agents: BootSection;
  projects: BootSection;
  models: BootSection;
}

/** A best-effort, cache-seeding read: no individual section can block boot. */
export function createBootRoutes(providers: BootPayloadProviders) {
  const app = new Hono();
  app.get('/', async (c) => {
    const entries = await Promise.all(
      Object.entries(providers).map(async ([name, read]) => {
        try {
          return [name, { data: await read(c) }] as const;
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
