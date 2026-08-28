import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const adaptersDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../adapters',
);
const orchestrationServicePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../services/orchestration/orchestration-service.ts',
);

function adapterSource(name: string): string {
  return readFileSync(join(adaptersDir, name), 'utf8');
}

const PROJECT_EVENT = 'eventStore.projectLiveEvent(event)';
const PERSIST_PROJECTED_EVENT =
  'eventStore?.appendEvent(projectedEvent, declaredOutputs)';
const LIVE_EVENT_BUS = 'eventBus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT';

function assertProjectedEventOrder(source: string) {
  const projected = source.indexOf(PROJECT_EVENT);
  const persisted = source.indexOf(PERSIST_PROJECTED_EVENT);
  const published = source.indexOf(LIVE_EVENT_BUS);
  const emittedProjectedEvent = source.indexOf(
    'event: projectedEvent',
    published,
  );

  if (projected < 0) throw new Error('missing event projection');
  if (persisted < 0)
    throw new Error('missing projected persistence with declared outputs');
  if (published < 0 || emittedProjectedEvent < published)
    throw new Error('missing projected live event bus emission');
  if (!(projected < persisted && persisted < published))
    throw new Error(
      'projection, persistence, and publication are out of order',
    );
}

/**
 * The provider inventory is deliberately source-derived. A new adapter that
 * emits a canonical turn start must join this list explicitly; otherwise its
 * attachment behavior has no reviewed projection proof and this test reds.
 */
const TURN_STARTED_ADAPTERS = [
  'acp-adapter.ts',
  'bedrock-adapter.ts',
  'claude-adapter.ts',
  'codex-adapter.ts',
  'muse-adapter.ts',
  'ollama-adapter.ts',
  'station-agent-adapter.ts',
] as const;

const ATTACHMENT_FORWARDING_ADAPTERS = [
  'acp-adapter.ts',
  'claude-adapter.ts',
  'codex-adapter.ts',
] as const;

describe('turn.started attachment projection inventory (station#4134)', () => {
  test('enumerates every provider adapter that emits turn.started', () => {
    const discovered = readdirSync(adaptersDir)
      .filter((name) => name.endsWith('-adapter.ts'))
      .filter((name) => /method:\s*'turn\.started'/u.test(adapterSource(name)))
      .sort();

    expect(discovered).toEqual([...TURN_STARTED_ADAPTERS].sort());
  });

  test('every attachment-forwarding adapter puts only its input on turn.started', () => {
    for (const name of ATTACHMENT_FORWARDING_ADAPTERS) {
      expect(
        adapterSource(name),
        `${name} must explicitly join the live attachment projection seam`,
      ).toMatch(
        /method:\s*'turn\.started'[\s\S]{0,900}?attachments:\s*input\.attachments/u,
      );
    }
  });

  test('projects before persistence and the live event bus for every provider event', () => {
    const source = readFileSync(orchestrationServicePath, 'utf8');
    expect(() => assertProjectedEventOrder(source)).not.toThrow();
  });

  test.each([
    [
      'persistence before projection',
      (source: string) =>
        source
          .replace(PROJECT_EVENT, 'projectLiveEvent(event)')
          .replace(
            PERSIST_PROJECTED_EVENT,
            `${PERSIST_PROJECTED_EVENT};\n    ${PROJECT_EVENT}`,
          ),
    ],
    [
      'unprojected persistence event',
      (source: string) =>
        source.replace(
          PERSIST_PROJECTED_EVENT,
          'eventStore?.appendEvent(event, declaredOutputs)',
        ),
    ],
    [
      'persistence without declared outputs',
      (source: string) =>
        source.replace(
          PERSIST_PROJECTED_EVENT,
          'eventStore?.appendEvent(projectedEvent)',
        ),
    ],
    [
      'unprojected live event',
      (source: string) => {
        const published = source.indexOf(LIVE_EVENT_BUS);
        return `${source.slice(0, published)}${source
          .slice(published)
          .replace('event: projectedEvent', 'event: event')}`;
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const source = readFileSync(orchestrationServicePath, 'utf8');
    expect(() => assertProjectedEventOrder(mutate(source))).toThrow();
  });
});
