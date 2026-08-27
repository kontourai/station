import type { Hono } from 'hono';

/**
 * station#1131 review round 1 (AC1 follow-up, HIGH item 2). Mirrors the
 * REAL composition shape `plugins.ts` uses: `createFixtureComposedRoutes`
 * owns a local `const app = new Hono()` and hands it to this sibling
 * `register*Routes(app, deps)` function, which attaches routes directly to
 * that shared app rather than being mounted as its own nested sub-router.
 * `/status` mirrors an ordinary, already-declared leaf; the
 * `__leaf_guard_fixture_composed_unmapped__` leaf is deliberately never
 * added to `PAIRING_SCOPE_FAMILY_INHERITED_LEAVES` — it exists only to
 * prove `pairing-route-leaf-scan.ts` follows this composition-helper
 * calling convention (not just the direct-call-factory shape the first
 * fixture, `fixture-leaf-routes.ts`, already covers).
 */
export function registerFixtureComposedSiblingRoutes(
  app: Hono,
  _deps: Record<string, never>,
): void {
  app.get('/status', (c) => c.json({ ok: true }));
  app.get('/__leaf_guard_fixture_composed_unmapped__', (c) =>
    c.json({ ok: true }),
  );
}
