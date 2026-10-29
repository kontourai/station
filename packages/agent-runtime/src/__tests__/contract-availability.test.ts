import { expect, it } from 'vitest';
import {
  DEFAULT_MODEL_POLICY,
  ModelMemoryVolume,
  openMemoryModelStorage,
} from '../index.js';

it('opens the model command port and reads an absent generation', async () => {
  const storage = openMemoryModelStorage({
    volume: new ModelMemoryVolume(),
    policy: DEFAULT_MODEL_POLICY,
    bodies: {
      put: async () => {
        throw new Error('No body write expected');
      },
      read: async () => {
        throw new Error('No body read expected');
      },
    },
    host: () => {
      throw new Error('authorization denied');
    },
  });
  try {
    await expect(
      storage.execute(
        {
          type: 'read',
          key: {
            scopeId: 's',
            conversationId: 'c',
            invocationId: 'i',
          },
        },
        { liveness: () => 'unknown' },
      ),
    ).resolves.toEqual({ kind: 'refused', reason: 'unavailable' });
  } finally {
    await storage.close();
  }
});
