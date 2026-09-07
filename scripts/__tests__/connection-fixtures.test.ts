import { describe, expect, test } from 'vitest';
import { supportsProviderManagedBinding } from '../../src-ui/src/utils/execution';
import { agentConnectionFixture } from '../../tests/helpers/connection-fixtures';

describe('engine fixture binding', () => {
  test.each(['claude', 'codex', 'muse', 'acp'])(
    'a %s fixture cannot become a Station-model binding',
    (engine) => {
      const connection = agentConnectionFixture({ id: engine, type: engine });
      expect(connection.config.engineId).toBe(engine);
      expect(
        supportsProviderManagedBinding(
          { execution: { agentConnectionId: connection.id } },
          [connection],
        ),
      ).toBe(false);
    },
  );
  test('an explicit engine identity remains authoritative over a transport name', () => {
    const connection = agentConnectionFixture({
      id: 'custom-launcher',
      type: 'agent-runtime',
      config: { engineId: 'codex', defaultModel: 'm' },
    });
    expect(connection.config).toMatchObject({
      engineId: 'codex',
      defaultModel: 'm',
    });
    expect(
      supportsProviderManagedBinding(
        { execution: { agentConnectionId: connection.id } },
        [connection],
      ),
    ).toBe(false);
  });
});
