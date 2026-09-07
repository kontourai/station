import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PROTECTED_STREAM_CONSUMERS = [
  'src-ui/src/contexts/MonitoringContext.tsx',
  'src-ui/src/hooks/useScheduler.ts',
  'src-ui/src/hooks/useServerEvents.ts',
  'src-ui/src/hooks/orchestration/useSessionEventStream.ts',
  'src-ui/src/hooks/orchestration/ensureOrchestrationEventStream.ts',
];

describe('protected browser stream inventory', () => {
  it.each(PROTECTED_STREAM_CONSUMERS)(
    '%s uses the shared authenticated fetch-SSE transport',
    (relativePath) => {
      const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8');
      expect(source).not.toMatch(/new\s+EventSource\s*\(/);
      expect(source).toMatch(/authenticated|fetchSse|fetchSSE/);
    },
  );

  it('uses one module-stable UUID header for the primary event stream', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src-ui/src/hooks/useServerEvents.ts'),
      'utf8',
    );
    expect(source).toContain(
      "import { randomCorrelationId } from '@kontourai/station-shared/random-id'",
    );
    expect(source).toContain(
      'const serverEventClientSessionId = randomCorrelationId()',
    );
    expect(source).toContain(
      "'X-Station-Client-Session': serverEventClientSessionId",
    );
    expect(source).not.toContain('sessionStorage.');
    expect(source).not.toContain('crypto.randomUUID()');
  });

  it('admits the exact liveness header through browser CORS only', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src-server/runtime/bootstrap/runtime-http.ts'),
      'utf8',
    );
    expect(source).toContain('X-Station-Client-Session');
  });
});
