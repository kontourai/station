import { describe, expect, test } from 'vitest';
import {
  collectRouteErrorEgressFindings,
  collectRouteErrorEgressFindingsForSources,
  findDirectRouteMessageEgress,
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
    // never sends it.
    expect(findDirectRouteMessageEgress(source, FILE)).toEqual([
      'src-server/routes/example.ts :: route POST /review :: String(error) :: 1',
    ]);
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
