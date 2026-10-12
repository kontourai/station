import type { PluginCommandEffectAdmissionRequest } from '@kontourai/station-contracts/plugin-command-effect';
import { describe, expect, test } from 'vitest';
import { TEST_OPERATOR_PRINCIPAL } from '../../../routes/plugins/__tests__/plugin-visibility-test-support.js';
import { createPluginCommandRequirementResolver } from '../plugin-command-effect-admission.js';

const request = (
  overrides: Partial<PluginCommandEffectAdmissionRequest> = {},
): PluginCommandEffectAdmissionRequest => ({
  documentId: 'document-0001',
  documentKey: 'k'.repeat(43),
  requestId: 'request-0001',
  issuedAt: Date.now(),
  installationGeneration: 'generation',
  commandId: 'demo.open',
  target: { kind: 'destination', destinationId: 'plugins' },
  ...overrides,
});

describe('plugin command requirements answer for the caller (M5)', () => {
  const alice = new Request('http://station.test/alice');
  const bob = new Request('http://station.test/bob');
  const readable = new Map([
    ['alice-session', alice],
    ['bob-session', bob],
  ]);
  const resolver = createPluginCommandRequirementResolver({
    canReadSession: (sessionId, authority) =>
      readable.get(sessionId) === authority,
    projectExists: (slug) => slug === 'demo',
    taskInProject: (taskId, projectSlug) =>
      taskId === 'task-1' && (!projectSlug || projectSlug === 'demo'),
  });
  const resolve = (
    requirement: 'active-chat' | 'session' | 'project' | 'task',
    context: PluginCommandEffectAdmissionRequest['context'],
    authority: Request,
    target?: PluginCommandEffectAdmissionRequest['target'],
  ) =>
    resolver({
      requirement,
      principal: TEST_OPERATOR_PRINCIPAL,
      request: request({ context, ...(target ? { target } : {}) }),
      authority,
    });

  test.each(['active-chat', 'session'] as const)(
    "%s: another caller's session is missing, exactly like one that does not exist",
    async (requirement) => {
      const field =
        requirement === 'active-chat' ? 'activeChatSessionId' : 'sessionId';
      await expect(
        resolve(requirement, { [field]: 'alice-session' }, alice),
      ).resolves.toBe('available');
      const foreign = await resolve(
        requirement,
        { [field]: 'bob-session' },
        alice,
      );
      const absent = await resolve(
        requirement,
        { [field]: 'no-such-session' },
        alice,
      );
      expect(foreign).toBe('missing');
      expect(absent).toBe(foreign);
      await expect(resolve(requirement, {}, alice)).resolves.toBe('missing');
    },
  );

  test('a composer target must be the very session the requirement names', async () => {
    await expect(
      resolve('active-chat', { activeChatSessionId: 'alice-session' }, alice, {
        kind: 'composer',
        sessionId: 'bob-session',
      }),
    ).resolves.toBe('missing');
  });

  test('project and task use the existence authority their routes answer with', async () => {
    await expect(
      resolve('project', { projectSlug: 'demo' }, bob),
    ).resolves.toBe('available');
    await expect(
      resolve('project', { projectSlug: 'other' }, bob),
    ).resolves.toBe('missing');
    await expect(
      resolve('task', { taskId: 'task-1', projectSlug: 'other' }, bob),
    ).resolves.toBe('missing');
    await expect(resolve('task', { taskId: 'task-1' }, bob)).resolves.toBe(
      'available',
    );
  });
});
