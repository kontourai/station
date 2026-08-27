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
    const projected = source.indexOf('eventStore.projectLiveEvent(event)');
    const persisted = source.indexOf('eventStore?.appendEvent(projectedEvent)');
    const published = source.indexOf(
      'eventBus.emit(SERVER_EVENTS.ORCHESTRATION_EVENT',
    );

    expect(projected).toBeGreaterThan(-1);
    expect(persisted).toBeGreaterThan(projected);
    expect(published).toBeGreaterThan(persisted);
  });
});
