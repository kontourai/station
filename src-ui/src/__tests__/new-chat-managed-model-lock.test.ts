/**
 * #4517: a managed lock on the Station's default model reaches New Chat.
 *
 * The server hides the fields a lock outranks with the contracts helper
 * `withoutLockedProjectFields` (`FileStorageAdapter.getProject`; the server
 * suite asserts it there). This feeds the same masked record to the New
 * Chat resolvers, composed as `useNewChatSelectionModel` composes them (the
 * Project's provider-managed execution, else the Station's), so a model the
 * Project's provider alone would supply cannot beat the locked default.
 */
import { withoutLockedProjectFields } from '@kontourai/station-contracts/managed-policy';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import { describe, expect, test } from 'vitest';
import {
  resolveGlobalProviderManagedExecution,
  resolveProjectProviderManagedExecution,
} from '../utils/execution';

const connection = (id: string, defaultModel: string): ConnectionConfig =>
  ({
    id,
    kind: 'model',
    type: 'ollama',
    name: id,
    enabled: true,
    capabilities: ['llm'],
    config: { defaultModel },
    status: 'ready',
    prerequisites: [],
  }) as unknown as ConnectionConfig;

const CONNECTIONS = [
  connection('station-provider', 'station-provider-model'),
  connection('project-provider', 'project-provider-model'),
];

/** The Station config `GET /config/app` serves with the lock applied. */
const STATION = {
  defaultLLMProvider: 'station-provider',
  defaultModel: 'managed-model',
};

/** `useNewChatSelectionModel`'s `providerManagedExecution`. */
function newChatExecution(project: {
  defaultProviderId?: string;
  defaultModel?: string;
}) {
  return (
    resolveProjectProviderManagedExecution(project, CONNECTIONS) ??
    resolveGlobalProviderManagedExecution(STATION, CONNECTIONS)
  );
}

const PROJECT = {
  defaultProviderId: 'project-provider',
  defaultModel: 'project-model',
};

describe('New Chat under a managed model lock', () => {
  test('without a lock the Project choice decides', () => {
    expect(newChatExecution(PROJECT)).toMatchObject({
      providerId: 'project-provider',
      model: 'project-model',
      executionScope: 'project',
    });
  });

  for (const locked of ['defaultModel', 'defaultLLMProvider']) {
    test(`a ${locked} lock: the Station's locked model, not one filled from the Project's provider`, () => {
      const masked = withoutLockedProjectFields(PROJECT, [locked]);
      expect(newChatExecution(masked)).toMatchObject({
        providerId: 'station-provider',
        model: 'managed-model',
        executionScope: 'global',
      });
    });
  }

  test('the half-pair the lock must not leave behind would have won', () => {
    // A provider alone resolves the provider's own model at Project scope;
    // this is why the lock takes the pair.
    expect(
      newChatExecution({ defaultProviderId: 'project-provider' }),
    ).toMatchObject({ model: 'project-provider-model' });
  });
});
