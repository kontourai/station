import { Hono } from 'hono';
import settingsRegistry from '../../generated/settings-registry.json' with {
  type: 'json',
};

/**
 * `GET /api/settings/registry` (#2144 slice 5) — the agent-facing
 * enumeration of every settings control and the deep link that opens it.
 *
 * The body is `src-server/generated/settings-registry.json` verbatim, built
 * from the UI settings catalog and the settings registries by
 * `scripts/gen-settings-registry.ts` and held to them by
 * `settings:registry:gate` in `verify:static:raw`. Nothing is derived here:
 * the owner decision on #2144 ruled out extraction at request time, and a
 * route that walked the UI catalog would put a `src-ui` import in the server
 * bundle.
 *
 * Imported as a module rather than read with `readFileSync`: the server
 * ships as a single esbuild bundle (`esbuild.config.mjs`) and nothing copies
 * `src-server/generated/` into `dist-server/`, so a path resolved relative to
 * this module would exist in the source checkout and be missing in every
 * packaged install. The `with { type: 'json' }` import is the shape already
 * used for `package.json` across the server (e.g.
 * `runtime/bootstrap/station-runtime.ts`), and esbuild inlines it.
 *
 * Read-only and secret-free by construction: labels, help sentences, scope
 * names, section ids and URL paths. No stored value appears here — a caller
 * that wants values reads `GET /config/app`, which is scoped separately.
 */
export function createSettingsRegistryRoutes() {
  const app = new Hono();

  app.get('/registry', (c) =>
    c.json({ success: true, data: settingsRegistry }),
  );

  return app;
}
