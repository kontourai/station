import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { streamSSE } from '../sse-response.js';

const ROUTE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SSE_RESPONSE_CONSTRUCTION =
  /\bstreamSSE\s*\(|header\s*\(\s*['"]Content-Type['"]\s*,\s*['"]text\/event-stream['"]/i;
// `(?:\.{1,2}\/)+` not `(?:\.\.\/)*`: a route file directly in `routes/` is a
// sibling of `sse-response.ts` and imports it as `./sse-response.js`. Matching
// only `../` failed such a file even though it was correctly guarded.
const SHARED_SSE_IMPORT = /from\s+['"](?:\.{1,2}\/)+sse-response\.js['"]/;
const BUFFERING_HEADER =
  /header\s*\(\s*['"]X-Accel-Buffering['"]\s*,\s*['"]no['"]\s*\)/i;

function routeSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : routeSourceFiles(path);
    }
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

describe('SSE response buffering guard', () => {
  test('the shared stream constructor disables nginx response buffering', async () => {
    const app = new Hono();
    app.get('/events', (c) =>
      streamSSE(c, async (stream) => {
        await stream.writeSSE({ data: 'ready' });
      }),
    );

    const response = await app.request('/events');

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
  });

  test('every SSE route construction uses the guarded constructor or header', () => {
    const unguarded = routeSourceFiles(ROUTE_ROOT).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      const constructsSse = SSE_RESPONSE_CONSTRUCTION.test(source);
      const disablesBuffering =
        SHARED_SSE_IMPORT.test(source) || BUFFERING_HEADER.test(source);
      return constructsSse && !disablesBuffering
        ? [relative(ROUTE_ROOT, path)]
        : [];
    });

    expect(unguarded).toEqual([]);
  });
});
