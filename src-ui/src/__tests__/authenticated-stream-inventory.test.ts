import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PROTECTED_STREAM_CONSUMERS = [
  'src-ui/src/contexts/MonitoringContext.tsx',
  'src-ui/src/hooks/useScheduler.ts',
  'src-ui/src/hooks/orchestration/useSessionEventStream.ts',
  'src-ui/src/hooks/orchestration/ensureOrchestrationEventStream.ts',
  // #90: a binary frame stream, not SSE, but the same auth boundary rule.
  'src-ui/src/live-surface/useLiveSurface.ts',
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
    // station#2301: the per-document id lives in its own module so the
    // orchestration stream sends the SAME id; it is still minted once, at
    // module scope, by randomCorrelationId — never sessionStorage (a cloned
    // tab would share it) and never a raw crypto.randomUUID().
    const read = (relativePath: string) =>
      readFileSync(resolve(process.cwd(), relativePath), 'utf8');
    const idModule = read('src-ui/src/hooks/clientDocumentSession.ts');
    expect(idModule).toContain(
      "import { randomCorrelationId } from '@kontourai/station-shared/random-id'",
    );
    expect(idModule).toContain(
      'export const CLIENT_DOCUMENT_SESSION_ID = randomCorrelationId()',
    );
    const streamSource = read(
      'src-ui/src/hooks/orchestration/ensureOrchestrationEventStream.ts',
    );
    expect(streamSource).toContain(
      "'X-Station-Client-Session': CLIENT_DOCUMENT_SESSION_ID",
    );
    expect(streamSource).not.toContain('sessionStorage.');
    expect(streamSource).not.toContain('crypto.randomUUID()');
    expect(idModule).not.toContain('sessionStorage.');
    expect(idModule).not.toContain('crypto.randomUUID()');
  });

  it('opens the general event stream only through the shared orchestration stream', () => {
    // #4370: the general and orchestration streams share one authenticated
    // transport, so the general mount must not open a stream of its own.
    const read = (relativePath: string) =>
      readFileSync(resolve(process.cwd(), relativePath), 'utf8');
    const mount = read('src-ui/src/hooks/ServerEventsMount.tsx');
    expect(mount).toContain('return ensureOrchestrationEventStream(');
    expect(mount).not.toMatch(/new\s+EventSource\s*\(|fetchSse|fetch\(/);
    expect(read('src-ui/src/hooks/useServerEvents.ts')).toContain(
      'useServerEventsTransport();',
    );
  });
});
