import { Hono } from 'hono';

/**
 * archive#1131 AC1 fixture. `/status` mirrors a normal, already-declared
 * leaf; `/__leaf_guard_fixture_unmapped__` is deliberately never added to
 * `PAIRING_SCOPE_FAMILY_INHERITED_LEAVES` in `pairing-route-scopes.ts` — it
 * exists only to prove `pairing-route-leaf-scan.ts` discovers a new leaf
 * under an already-covered mount base, and that `isLeafScopeDeclared` then
 * flags it as undeclared. See `pairing-route-scopes.test.ts`'s "leaf-level
 * coverage" describe block.
 */
export function createFixtureLeafRoutes() {
  const app = new Hono();
  app.get('/status', (c) => c.json({ ok: true }));
  app.get('/__leaf_guard_fixture_unmapped__', (c) => c.json({ ok: true }));
  return app;
}
