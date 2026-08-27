import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER,
  type StationAnswerNarrativePublishInput,
} from '@kontourai/station-contracts/answer-narrative-binding';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { afterEach, describe, expect, test } from 'vitest';
import {
  AnswerNarrativeBindingModule,
  AnswerNarrativeConflictError,
  AnswerNarrativeNotFoundError,
  AnswerNarrativeUnavailableError,
} from '../answer-narrative-binding-module.js';

const roots: string[] = [];
const authority = sessionReadAuthorityFromRequest(
  'owner',
  undefined,
  undefined,
);

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function home() {
  const root = mkdtempSync(join(tmpdir(), 'station-answer-narrative-'));
  roots.push(root);
  return root;
}

const binding = {
  version: 'station-answer-binding/v1' as const,
  sessionId: 'session-a',
  turnId: 'turn-a',
  answer: {
    authority: '@kontourai/thread' as const,
    schemaVersion: '1.2.0' as const,
    kind: 'assistant-message' as const,
    standing: 'observed' as const,
    threadId: 'session-a',
    messageId: 'message-a',
  },
};
const answer = {
  status: 'found' as const,
  sessionId: 'session-a',
  turnId: 'turn-a',
  observedAt: '2026-08-26T00:00:00.000Z',
  binding,
  projectSlug: 'project-a',
  inputs: [],
  results: [],
};

function publication(
  publicationId: string,
  expectedRevision: number,
  envelopeSha256 = 'a'.repeat(64),
): StationAnswerNarrativePublishInput {
  return {
    expectedAnswer: binding,
    publicationId,
    expectedRevision,
    ownerId: STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER,
    narrativeRef: {
      schemaVersion: 'grounded-narrative-ref/v1',
      narrativeId: 'narrative-a',
      envelopeSha256,
    },
  };
}

function owner() {
  return {
    capture: () => ({
      ownerId: STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER,
      projectId: 'project-a',
      workspacePath: '/workspace',
      narrativeDir: '/workspace/.kontourai/narrative/narrative-a',
      configurationFingerprint: 'fingerprint',
    }),
    isCurrent: () => true,
    read: async () => ({
      state: 'available' as const,
      observedAt: answer.observedAt,
      process: {} as never,
    }),
  };
}

describe('AnswerNarrativeBindingModule', () => {
  test('uses the exact durable answer seam and classifies unavailable state', async () => {
    const module = new AnswerNarrativeBindingModule(
      home(),
      { read: async () => ({ status: 'unavailable' as const }) },
      owner(),
    );
    await expect(
      module.publish(
        'session-a',
        'turn-a',
        publication('publish-a', 0),
        authority,
        () => true,
      ),
    ).rejects.toBeInstanceOf(AnswerNarrativeUnavailableError);

    const missing = new AnswerNarrativeBindingModule(
      home(),
      { read: async () => ({ status: 'not-found' as const }) },
      owner(),
    );
    await expect(
      missing.publish(
        'session-a',
        'turn-a',
        publication('publish-a', 0),
        authority,
        () => true,
      ),
    ).rejects.toBeInstanceOf(AnswerNarrativeNotFoundError);
  });

  test('keeps publication ids globally unique across revisions, tombstones, and restart', async () => {
    const root = home();
    const source = { read: async () => answer };
    const module = new AnswerNarrativeBindingModule(root, source, owner());
    await expect(
      module.publish(
        'session-a',
        'turn-a',
        publication('publish-a', 0),
        authority,
        () => true,
      ),
    ).resolves.toMatchObject({ revision: 1, active: true });
    await expect(
      module.publish(
        'session-a',
        'turn-a',
        publication('publish-b', 1, 'b'.repeat(64)),
        authority,
        () => true,
      ),
    ).resolves.toMatchObject({ revision: 2, active: true });

    const restarted = new AnswerNarrativeBindingModule(root, source, owner());
    await expect(
      restarted.publish(
        'session-a',
        'turn-a',
        publication('publish-a', 0),
        authority,
        () => true,
      ),
    ).resolves.toMatchObject({ revision: 1, active: true });
    await expect(
      restarted.publish(
        'session-a',
        'turn-a',
        publication('publish-a', 2, 'c'.repeat(64)),
        authority,
        () => true,
      ),
    ).rejects.toBeInstanceOf(AnswerNarrativeConflictError);
    const removed = await restarted.remove(
      'session-a',
      'turn-a',
      2,
      authority,
      () => true,
    );
    await expect(
      restarted.remove('session-a', 'turn-a', 2, authority, () => true),
    ).resolves.toEqual(removed);

    const stored = JSON.parse(
      readFileSync(
        join(root, 'answer-narrative-bindings', 'index.json'),
        'utf8',
      ),
    ) as { records: Array<{ publicationId: string }> };
    expect(new Set(stored.records.map((row) => row.publicationId)).size).toBe(
      stored.records.length,
    );
  });

  test('does not append after authority revokes while queued on the mutation lock', async () => {
    const root = home();
    const index = join(root, 'answer-narrative-bindings', 'index.json');
    mkdirSync(join(root, 'answer-narrative-bindings'), { recursive: true });
    const release = await acquireFileMutationLockAsync(`${index}.mutation`);
    let current = true;
    const module = new AnswerNarrativeBindingModule(
      root,
      { read: async () => answer },
      owner(),
    );
    try {
      const pending = module.publish(
        'session-a',
        'turn-a',
        publication('publish-a', 0),
        authority,
        () => current,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      current = false;
      await release();
      await expect(pending).rejects.toBeInstanceOf(
        AnswerNarrativeNotFoundError,
      );
      expect(existsSync(index)).toBe(false);
    } finally {
      try {
        await release();
      } catch {}
    }
  });

  test('does not commit a publish into a workspace rebound while it waits for the mutation lock', async () => {
    const root = home();
    const index = join(root, 'answer-narrative-bindings', 'index.json');
    mkdirSync(join(root, 'answer-narrative-bindings'), { recursive: true });
    const release = await acquireFileMutationLockAsync(`${index}.mutation`);
    let workspace = '/workspace-a';
    const module = new AnswerNarrativeBindingModule(
      root,
      { read: async () => answer },
      {
        capture: () => ({
          ownerId: STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER,
          projectId: 'project-a',
          workspacePath: workspace,
          narrativeDir: `${workspace}/.kontourai/narrative/narrative-a`,
          configurationFingerprint: `fingerprint:${workspace}`,
        }),
        isCurrent: (configured) => configured.workspacePath === workspace,
        read: async () => ({
          state: 'available' as const,
          observedAt: answer.observedAt,
          process: {} as never,
        }),
      },
    );
    try {
      const pending = module.publish(
        'session-a',
        'turn-a',
        publication('publish-a', 0),
        authority,
        () => true,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      workspace = '/workspace-b';
      await release();
      await expect(pending).rejects.toBeInstanceOf(
        AnswerNarrativeNotFoundError,
      );
      expect(existsSync(index)).toBe(false);
    } finally {
      try {
        await release();
      } catch {}
    }
  });

  test('keeps the committed update observable but withholds its receipt after response authority expires', async () => {
    let current = true;
    const updates: Array<{ revision: number }> = [];
    const module = new AnswerNarrativeBindingModule(
      home(),
      { read: async () => answer },
      owner(),
      (update) => {
        updates.push(update);
        current = false;
      },
    );
    await expect(
      module.publish(
        'session-a',
        'turn-a',
        publication('publish-a', 0),
        authority,
        () => current,
      ),
    ).rejects.toBeInstanceOf(AnswerNarrativeNotFoundError);
    expect(updates).toEqual([
      { revision: 1, active: true, sessionId: 'session-a', turnId: 'turn-a' },
    ]);
  });

  test('refuses a deterministic tombstone ID reserved by another answer after restart', async () => {
    const root = home();
    const otherBinding = {
      ...binding,
      sessionId: 'session-b',
      turnId: 'turn-b',
      answer: {
        ...binding.answer,
        threadId: 'session-b',
        messageId: 'message-b',
      },
    };
    const otherAnswer = {
      ...answer,
      sessionId: 'session-b',
      turnId: 'turn-b',
      binding: otherBinding,
    };
    const source = {
      read: async (sessionId: string) =>
        sessionId === 'session-a' ? answer : otherAnswer,
    };
    const module = new AnswerNarrativeBindingModule(root, source, owner());
    await module.publish(
      'session-a',
      'turn-a',
      publication('publish-a', 0),
      authority,
      () => true,
    );
    const reservedId = `tombstone:${createHash('sha256')
      .update(
        JSON.stringify([
          'station.answer-narrative-binding/tombstone/v1',
          'session-a',
          'turn-a',
          2,
          'publish-a',
        ]),
      )
      .digest('hex')}`;
    await module.publish(
      'session-b',
      'turn-b',
      { ...publication(reservedId, 0), expectedAnswer: otherBinding },
      authority,
      () => true,
    );

    const restarted = new AnswerNarrativeBindingModule(root, source, owner());
    await expect(
      restarted.remove('session-a', 'turn-a', 1, authority, () => true),
    ).rejects.toBeInstanceOf(AnswerNarrativeConflictError);
    const stored = JSON.parse(
      readFileSync(
        join(root, 'answer-narrative-bindings', 'index.json'),
        'utf8',
      ),
    ) as { records: Array<{ active: boolean }> };
    expect(stored.records).toHaveLength(2);
    expect(stored.records.every((row) => row.active)).toBe(true);
  });

  test.each([
    'not-captured',
    'unsupported-version',
    'corrupt',
    'unavailable',
    'restricted',
  ] as const)(
    'maps the %s retained-owner read arm without promoting it',
    async (state) => {
      let readState: 'available' | typeof state = 'available';
      const module = new AnswerNarrativeBindingModule(
        home(),
        { read: async () => answer },
        {
          capture: owner().capture,
          isCurrent: owner().isCurrent,
          read: async () =>
            readState === 'available'
              ? {
                  state: 'available' as const,
                  observedAt: answer.observedAt,
                  process: {} as never,
                }
              : { state: readState, observedAt: answer.observedAt },
        },
      );
      await module.publish(
        'session-a',
        'turn-a',
        publication('publish-a', 0),
        authority,
        () => true,
      );
      readState = state;
      await expect(
        module.readExactAnswerNarrative({
          authorizedAnswer: answer,
          authority,
        }),
      ).resolves.toEqual({
        owner: { authority: '@kontourai/flow-agents' },
        state,
        observedAt: answer.observedAt,
      });
    },
  );

  test('keeps an explicit historical revision readable after a later tombstone', async () => {
    const retained = {
      state: 'available' as const,
      observedAt: answer.observedAt,
      process: {
        narrativeId: 'narrative-a',
        runtime: {
          documentActions: [],
          turns: [],
          coverage: { sources: 0, unavailable: 0 },
        },
        capture: {
          channels: { inactive: 0, unknown: 0 },
          knownGapClasses: [],
        },
      } as never,
    };
    const module = new AnswerNarrativeBindingModule(
      home(),
      { read: async () => answer },
      {
        ...owner(),
        read: async () => retained,
      },
    );
    await module.publish(
      'session-a',
      'turn-a',
      publication('publish-a', 0),
      authority,
      () => true,
    );
    await module.remove('session-a', 'turn-a', 1, authority, () => true);
    await expect(
      module.readExactAnswerNarrative({
        authorizedAnswer: answer,
        authority,
        revision: 1,
      }),
    ).resolves.toMatchObject({
      owner: { authority: '@kontourai/flow-agents' },
      state: 'available',
    });
  });
});
