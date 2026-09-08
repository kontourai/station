import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  collectRouteErrorEgressFindings,
  collectRouteErrorEgressFindingsForSources,
  findDirectRouteMessageEgress,
  findRouteErrorReexports,
  findUnsafeTransportErrorEgress,
} from '../route-error-egress-gate.mjs';

const FILE = 'src-server/routes/example.ts';
const REVIEWED_SAFE_IDENTITY =
  'src-server/routes/example.ts :: route POST /safe :: result.message :: 1';

describe('route error egress gate', () => {
  test('accepts the checked-in typed-result inventory', () => {
    expect(collectRouteErrorEgressFindings({ rootDir: process.cwd() })).toEqual(
      [],
    );
  });

  test('detects a multiline conditional direct response message', () => {
    const source = `
      app.post('/safe', (c) =>
        c.json({
          error: accepted
            ? result.message
            : fallback.message,
        }),
      );
    `;

    expect(findDirectRouteMessageEgress(source, FILE)).toEqual([
      REVIEWED_SAFE_IDENTITY,
      'src-server/routes/example.ts :: route POST /safe :: fallback.message :: 1',
    ]);
    expect(
      collectRouteErrorEgressFindingsForSources(
        { [FILE]: source },
        { reviewed: new Set([REVIEWED_SAFE_IDENTITY]) },
      ),
    ).toEqual([
      'Unreviewed direct outward .message serialization: src-server/routes/example.ts :: route POST /safe :: fallback.message :: 1.',
    ]);
  });

  test('rejects a same-file safe-to-unsafe expression substitution', () => {
    const safeSource = `app.post('/safe', (c) => c.json({ error: result.message }));`;
    const unsafeSource = `app.post('/safe', (c) => c.json({ error: error.message }));`;
    const reviewed = new Set([REVIEWED_SAFE_IDENTITY]);

    expect(
      collectRouteErrorEgressFindingsForSources(
        { [FILE]: safeSource },
        { reviewed },
      ),
    ).toEqual([]);
    expect(
      collectRouteErrorEgressFindingsForSources(
        { [FILE]: unsafeSource },
        { reviewed },
      ),
    ).toEqual([
      'Unreviewed direct outward .message serialization: src-server/routes/example.ts :: route POST /safe :: error.message :: 1.',
      'Stale reviewed direct outward .message serialization: src-server/routes/example.ts :: route POST /safe :: result.message :: 1.',
    ]);
  });

  test('rejects multiline raw error coercion across SSE, WebSocket, and MCP diagnostics', () => {
    const source = `
      async function write(streamWriter, ws, logger) {
        try {
          await task();
        } catch (failure) {
          await streamWriter.write(
            \`data: \${failure}\\n\\n\`,
          );
          ws.send(JSON.stringify({ error: String(failure) }));
          logger.warn('mcp renderer failed', {
            message: failure.message,
          });
        }
      }
    `;

    expect(findUnsafeTransportErrorEgress(source, FILE)).toEqual([
      'src-server/routes/example.ts :: function write :: $' + '{failure}',
      'src-server/routes/example.ts :: function write :: String(failure)',
      'src-server/routes/example.ts :: function write :: failure.message',
    ]);
  });

  test('follows raw error bindings through aliases and intermediate assignments into each transport sink', () => {
    const source = `
      function write(ws, socket) {
        try {
          task();
        } catch (thrown) {
          const rendered = String(thrown);
          socket.send(rendered);
          this.ws.send(thrown.message);
          console.warn(thrown);
        }
      }
    `;

    const findings = findUnsafeTransportErrorEgress(source, FILE);
    expect(findings).toContain(
      'src-server/routes/example.ts :: function write :: String(thrown)',
    );
    expect(findings).toContain(
      'src-server/routes/example.ts :: function write :: thrown.message',
    );
    expect(findings).toContain(
      'src-server/routes/example.ts :: function write :: thrown',
    );
  });

  test('tracks arbitrary catch bindings and scoped reassignment without tainting an unrelated safe name', () => {
    const source = `
      function write(ws) {
        const failure = 'safe';
        try { task(); } catch (caught) {
          let detail = caught;
          detail = String(detail);
          ws.send(detail);
        }
        ws.send(failure);
      }
    `;

    expect(findUnsafeTransportErrorEgress(source, FILE)).toEqual([
      'src-server/routes/example.ts :: function write :: String(detail)',
    ]);
  });

  test('discovers runtime member roots and rejects a caught message at their context alias', () => {
    const source = `
      function register(context) {
        context.app.get('/reviews', (routeContext) => {
          try { task(); } catch (failure) {
            return routeContext.json({ error: failure.message });
          }
        });
      }
    `;

    expect(findDirectRouteMessageEgress(source, FILE)).toEqual([
      'src-server/routes/example.ts :: route GET /reviews :: failure.message :: 1',
    ]);
  });

  test('discovers renamed Hono roots and Context aliases', () => {
    const source = `
      const routeRoot = new Hono();
      routeRoot.post('/review', (context) => {
        const reply = context;
        return reply.json({ error: error.message });
      });
    `;

    expect(findDirectRouteMessageEgress(source, FILE)).toEqual([
      'src-server/routes/example.ts :: route POST /review :: error.message :: 1',
    ]);
  });

  test('flags a caught message thrown through a RouteError, in the message and in details', () => {
    // The lane-R0 review's probe, verbatim in shape: before the constructor
    // became a sink this produced ZERO findings, so migrating a route from
    // `c.json({ error: errorMessage(e) }, 400)` to `throw new RouteError(...)`
    // removed it from review while sending strictly more to the client.
    const source = `
      app.post('/review', async (context) => {
        try {
          await task();
        } catch (error) {
          throw new RouteError(400, (error as Error).message, {
            details: { raw: (error as Error).message },
            cause: error,
          });
        }
      });
    `;

    expect(findDirectRouteMessageEgress(source, FILE)).toEqual([
      'src-server/routes/example.ts :: route POST /review :: (error as Error).message :: 1',
      'src-server/routes/example.ts :: route POST /review :: (error as Error).message :: 2',
    ]);
    expect(
      collectRouteErrorEgressFindingsForSources(
        { [FILE]: source },
        { reviewed: new Set() },
      ),
    ).toEqual([
      'Unreviewed direct outward .message serialization: src-server/routes/example.ts :: route POST /review :: (error as Error).message :: 1.',
      'Unreviewed direct outward .message serialization: src-server/routes/example.ts :: route POST /review :: (error as Error).message :: 2.',
    ]);
  });

  test('follows a caught error into a RouteError through an alias, and leaves cause and sanitized text alone', () => {
    const source = `
      app.post('/review', async (context) => {
        try {
          await task();
        } catch (error) {
          const detail = String(error);
          throw new RouteError(500, detail, { cause: error });
        }
      });
    `;

    // `detail` is an alias of the caught value, so it is flagged even though
    // no `.message` appears; `cause: error` is not, because the boundary
    // never sends it. The identity is the expression AT THE SINK, so two
    // tainted arguments in one route are two reviewable entries rather than
    // two occurrences of the shared taint root.
    expect(findDirectRouteMessageEgress(source, FILE)).toEqual([
      'src-server/routes/example.ts :: route POST /review :: detail :: 1',
    ]);
  });

  test('names the field when a caught error contributes structured data, not the taint root', () => {
    const source = `
      app.post('/review', async (context) => {
        try {
          await task();
        } catch (error) {
          throw new RouteError(409, 'Already claimed', {
            code: (error as any).code,
            details: { conflictId: (error as any).conflictId },
            cause: error,
          });
        }
      });
    `;

    // Both are reads off the caught value, and neither is `.message`, so the
    // taint resolver is what finds them. Recorded whole: an allowlist entry
    // has to say WHICH field was reviewed, and before this both of these
    // were `:: error :: 1` and `:: error :: 2`.
    expect(findDirectRouteMessageEgress(source, FILE)).toEqual([
      'src-server/routes/example.ts :: route POST /review :: (error as any).code :: 1',
      'src-server/routes/example.ts :: route POST /review :: (error as any).conflictId :: 1',
    ]);
  });

  test('matches the RouteError binding through an alias or a namespace import', () => {
    const aliased = `
      import { RouteError as RE } from '../../utils/route-error.js';
      app.post('/review', async (context) => {
        try {
          await task();
        } catch (error) {
          throw new RE(400, (error as Error).message);
        }
      });
    `;
    const namespaced = `
      import * as Errors from '../../utils/route-error.js';
      app.post('/review', async (context) => {
        try {
          await task();
        } catch (error) {
          throw new Errors.RouteError(400, (error as Error).message);
        }
      });
    `;

    // Both were clean before the binding was resolved from the import: a
    // one-line rename took a route out of review while it sent strictly
    // more to the client.
    expect(findDirectRouteMessageEgress(aliased, FILE)).toEqual([
      'src-server/routes/example.ts :: route POST /review :: (error as Error).message :: 1',
    ]);
    expect(findDirectRouteMessageEgress(namespaced, FILE)).toEqual([
      'src-server/routes/example.ts :: route POST /review :: (error as Error).message :: 1',
    ]);
  });

  test('reviews a RouteError import whose specifier does not resolve, rather than skipping it', () => {
    const source = `
      import { RouteError } from './board-route-error.js';
      app.post('/review', async (context) => {
        try {
          await task();
        } catch (error) {
          throw new RouteError(400, (error as Error).message);
        }
      });
    `;

    // Nothing on disk answers this specifier here, so the gate cannot tell an
    // unrelated class from a barrel that re-exports the real one. It reviews
    // the spelling and lets the allowlist absorb the rare unrelated class --
    // the opposite tie-break skips whichever one it guessed wrong about, and
    // the expensive direction to be wrong in is "skipped".
    expect(findDirectRouteMessageEgress(source, FILE)).toEqual([
      'src-server/routes/example.ts :: route POST /review :: (error as Error).message :: 1',
    ]);
  });

  test('leaves a differently-named local class alone', () => {
    // The true negative the resolver can establish without reading anything:
    // this constructs something else entirely.
    const source = `
      class BoardError extends Error {}
      app.post('/review', async (context) => {
        try {
          await task();
        } catch (error) {
          throw new BoardError((error as Error).message);
        }
      });
    `;

    expect(findDirectRouteMessageEgress(source, FILE)).toEqual([]);
  });

  test('still reviews the spelling in a file that imports no RouteError at all', () => {
    // Every case above that omits the import relies on this.
    const source = `
      app.post('/review', async (context) => {
        try {
          await task();
        } catch (error) {
          throw new RouteError(400, (error as Error).message);
        }
      });
    `;

    expect(findDirectRouteMessageEgress(source, FILE)).toEqual([
      'src-server/routes/example.ts :: route POST /review :: (error as Error).message :: 1',
    ]);
  });

  describe('re-export resolution', () => {
    const roots: string[] = [];

    afterEach(() => {
      for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
      }
    });

    function fixture(files: Record<string, string>) {
      const root = mkdtempSync(join(tmpdir(), 'route-error-gate-'));
      roots.push(root);
      for (const [path, contents] of Object.entries(files)) {
        const absolute = join(root, path);
        mkdirSync(join(absolute, '..'), { recursive: true });
        writeFileSync(absolute, contents);
      }
      return root;
    }

    const ROUTE_ERROR_SOURCE = 'export class RouteError extends Error {}\n';
    const ROUTE = `
      import { RouteError } from '../schemas/schemas.js';
      app.post('/review', async (context) => {
        try {
          await task();
        } catch (error) {
          throw new RouteError(400, (error as Error).message);
        }
      });
    `;

    test('follows a barrel that re-exports the class', () => {
      // `schemas/schemas.ts` is a barrel 53 of 54 route files already import
      // from, so one `export { RouteError } from` line there is the cheapest
      // way to take every lane out of review.
      const root = fixture({
        'src-server/utils/route-error.ts': ROUTE_ERROR_SOURCE,
        'src-server/routes/schemas/schemas.ts':
          "export { RouteError } from '../../utils/route-error.js';\n",
        'src-server/routes/projects/example.ts': ROUTE,
      });

      expect(
        findDirectRouteMessageEgress(
          ROUTE,
          'src-server/routes/projects/example.ts',
          { rootDir: root },
        ),
      ).toEqual([
        'src-server/routes/projects/example.ts :: route POST /review :: (error as Error).message :: 1',
      ]);
    });

    test('follows a barrel that renames the class on the way out', () => {
      const renamed = ROUTE.replace(
        "import { RouteError } from '../schemas/schemas.js';",
        "import { HttpRefusal } from '../schemas/schemas.js';",
      ).replace('new RouteError(', 'new HttpRefusal(');
      const root = fixture({
        'src-server/utils/route-error.ts': ROUTE_ERROR_SOURCE,
        'src-server/routes/schemas/schemas.ts':
          "export { RouteError as HttpRefusal } from '../../utils/route-error.js';\n",
        'src-server/routes/projects/example.ts': renamed,
      });

      expect(
        findDirectRouteMessageEgress(
          renamed,
          'src-server/routes/projects/example.ts',
          { rootDir: root },
        ),
      ).toEqual([
        'src-server/routes/projects/example.ts :: route POST /review :: (error as Error).message :: 1',
      ]);
    });

    test('skips an import from a module that resolves and does not provide the class', () => {
      // The only negative this resolver can establish by reading rather than
      // guessing: the specifier resolved, and the class is not there.
      const root = fixture({
        'src-server/utils/route-error.ts': ROUTE_ERROR_SOURCE,
        'src-server/routes/schemas/schemas.ts':
          'export class RouteError extends Error {}\n',
        'src-server/routes/projects/example.ts': ROUTE,
      });

      expect(
        findDirectRouteMessageEgress(
          ROUTE,
          'src-server/routes/projects/example.ts',
          { rootDir: root },
        ),
      ).toEqual([]);
    });

    test('reports a second-level barrel instead of silently failing to follow it', () => {
      // The resolver stops at one level on purpose. This is what keeps that
      // from being a hole: the shape it cannot follow is reported here.
      const root = fixture({
        'src-server/utils/route-error.ts': ROUTE_ERROR_SOURCE,
        'src-server/routes/schemas/inner.ts':
          "export { RouteError } from '../../utils/route-error.js';\n",
        'src-server/routes/schemas/schemas.ts':
          "export { RouteError } from './inner.js';\n",
      });

      expect(findRouteErrorReexports({ rootDir: root })).toEqual([
        "src-server/routes/schemas/schemas.ts re-exports RouteError through './inner.js', which the egress gate's one-level resolver cannot follow.",
      ]);
    });

    test('reports a star re-export of a module that provides the class', () => {
      const root = fixture({
        'src-server/utils/route-error.ts': ROUTE_ERROR_SOURCE,
        'src-server/routes/schemas/inner.ts':
          "export { RouteError } from '../../utils/route-error.js';\n",
        'src-server/routes/schemas/schemas.ts': "export * from './inner.js';\n",
      });

      expect(findRouteErrorReexports({ rootDir: root })).toEqual([
        "src-server/routes/schemas/schemas.ts re-exports RouteError through './inner.js', which the egress gate's one-level resolver cannot follow.",
      ]);
    });

    test('accepts a barrel the resolver can follow, and this repo has none it cannot', () => {
      const root = fixture({
        'src-server/utils/route-error.ts': ROUTE_ERROR_SOURCE,
        'src-server/routes/schemas/schemas.ts':
          "export { RouteError } from '../../utils/route-error.js';\n",
      });
      expect(findRouteErrorReexports({ rootDir: root })).toEqual([]);

      // The real assertion. The four cases above are what make it mean
      // something: an empty list from a scanner that never fires would look
      // identical.
      expect(findRouteErrorReexports({ rootDir: process.cwd() })).toEqual([]);
    });
  });

  test('accepts a RouteError built from literals or from sanitized text', () => {
    const source = `
      app.post('/review', async (context) => {
        try {
          await task();
        } catch (error) {
          throw new RouteError(400, 'Invalid workflow id', {
            code: 'workflow_invalid',
            details: { field: 'workflowId' },
            cause: error,
          });
        }
      });
      app.post('/other', async (context) => {
        try {
          await task();
        } catch (error) {
          throw new RouteError(400, sanitizeFreeText((error as Error).message), {
            cause: error,
          });
        }
      });
    `;

    expect(findDirectRouteMessageEgress(source, FILE)).toEqual([]);
  });

  test('taints an arbitrary typed error callback parameter without name matching', () => {
    const source = `
      socket.on('error', (providerFault) => {
        ws.send(String(providerFault));
      });
    `;

    expect(findUnsafeTransportErrorEgress(source, FILE)).toEqual([
      'src-server/routes/example.ts :: route ON error :: String(providerFault)',
    ]);
  });
});
