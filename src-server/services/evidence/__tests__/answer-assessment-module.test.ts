import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createStationAnswerBinding,
  type StationAnswerBinding,
} from '@kontourai/station-contracts';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { describe, expect, test } from 'vitest';
import {
  AnswerAssessmentModule,
  AnswerAssessmentNotFoundError,
  AnswerAssessmentUnavailableError,
  stationAnswerAssessmentClaimProfile,
} from '../answer-assessment-module.js';

const binding: StationAnswerBinding = createStationAnswerBinding({
  sessionId: 'session-a',
  turnId: 'turn-a',
  messageId: 'message-a',
});
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
const authority = sessionReadAuthorityFromRequest(
  'owner',
  undefined,
  undefined,
);

function bundle(profile = true) {
  const value = JSON.parse(
    readFileSync(
      join(
        process.cwd(),
        'node_modules/@kontourai/surface/examples/answer-provenance.json',
      ),
      'utf8',
    ),
  );
  const claim = value.claims[0];
  if (profile)
    Object.assign(claim, stationAnswerAssessmentClaimProfile(binding));
  return value;
}

describe('AnswerAssessmentModule', () => {
  test('holds the mutation lock through awaited owner authorization', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-assessment-lock-'));
    let reads = 0;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const module = new AnswerAssessmentModule(home, {
      read: async () => {
        reads += 1;
        if (reads === 3) await held;
        return answer;
      },
    });
    const input = {
      expectedAnswer: binding,
      publicationId: 'publication-a',
      bundle: bundle(),
      claimId: 'answer.supported',
      expectedRevision: 0,
    };
    const first = module.publish(
      'session-a',
      'turn-a',
      input,
      authority,
      () => true,
    );
    while (reads < 3) await new Promise((resolve) => setTimeout(resolve, 0));
    const second = module.publish(
      'session-a',
      'turn-a',
      { ...input, publicationId: 'publication-b' },
      authority,
      () => true,
    );
    while (reads < 5) await new Promise((resolve) => setTimeout(resolve, 0));
    // A second publisher reached its pre-lock owner reads but cannot enter its
    // lock-protected read/write until the first publisher commits.
    expect(existsSync(join(home, 'answer-assessments', 'index.json'))).toBe(
      false,
    );
    release!();
    await expect(first).resolves.toMatchObject({ revision: 1 });
    await expect(second).rejects.toThrow('Assessment revision conflicts');
    rmSync(home, { recursive: true, force: true });
  });

  test('an empty assessment read neither creates a home directory nor a mutation lock', async () => {
    const home = join(
      tmpdir(),
      `station-assessment-read-${Date.now()}-${Math.random()}`,
    );
    const module = new AnswerAssessmentModule(home, {
      read: async () => answer,
    });
    await expect(
      module.readExactAnswerAssessment({ authorizedAnswer: answer, authority }),
    ).resolves.toMatchObject({ state: 'not-captured' });
    expect(existsSync(home)).toBe(false);
  });

  test('returns a guarded read-only CAS target across publish, restart, removal, and resurrection', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-assessment-target-'));
    try {
      const module = new AnswerAssessmentModule(home, {
        read: async () => answer,
      });
      expect(module.readTarget(answer, authority, () => true)).toMatchObject({
        expectedAnswer: binding,
        revision: 0,
        active: false,
      });
      expect(existsSync(join(home, 'answer-assessments'))).toBe(false);

      await expect(
        module.publish(
          'session-a',
          'turn-a',
          {
            expectedAnswer: binding,
            publicationId: 'publication-a',
            bundle: bundle(),
            claimId: 'answer.supported',
            expectedRevision: 0,
          },
          authority,
          () => true,
        ),
      ).resolves.toMatchObject({ revision: 1, active: true });

      const restarted = new AnswerAssessmentModule(home, {
        read: async () => answer,
      });
      expect(restarted.readTarget(answer, authority, () => true)).toMatchObject(
        {
          revision: 1,
          active: true,
        },
      );
      await expect(
        restarted.remove('session-a', 'turn-a', 1, authority, () => true),
      ).resolves.toMatchObject({ revision: 2, active: false });
      expect(restarted.readTarget(answer, authority, () => true)).toMatchObject(
        {
          revision: 2,
          active: false,
        },
      );
      await expect(
        restarted.publish(
          'session-a',
          'turn-a',
          {
            expectedAnswer: binding,
            publicationId: 'publication-b',
            bundle: bundle(),
            claimId: 'answer.supported',
            expectedRevision: 2,
          },
          authority,
          () => true,
        ),
      ).resolves.toMatchObject({ revision: 3, active: true });

      const foreign = sessionReadAuthorityFromRequest(
        'other-owner',
        undefined,
        undefined,
      );
      expect(() => restarted.readTarget(answer, foreign, () => true)).toThrow(
        AnswerAssessmentNotFoundError,
      );
      expect(() =>
        restarted.readTarget(
          { ...answer, projectSlug: 'project-other' },
          authority,
          () => true,
        ),
      ).toThrow(AnswerAssessmentNotFoundError);
      expect(() =>
        restarted.readTarget(
          {
            ...answer,
            binding: {
              ...binding,
              answer: { ...binding.answer, messageId: 'stale-message' },
            },
          },
          authority,
          () => true,
        ),
      ).toThrow(AnswerAssessmentNotFoundError);

      writeFileSync(
        join(home, 'answer-assessments', 'index.json'),
        '{not-json',
      );
      expect(() => restarted.readTarget(answer, authority, () => true)).toThrow(
        AnswerAssessmentUnavailableError,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('only accepts a concrete exact-answer content profile, persists by immutable bytes, and tombstones removal', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-assessment-'));
    try {
      const module = new AnswerAssessmentModule(home, {
        read: async () => answer,
      });
      await expect(
        module.publish(
          'session-a',
          'turn-a',
          {
            expectedAnswer: binding,
            publicationId: 'publication-a',
            bundle: bundle(false),
            claimId: 'answer.supported',
            expectedRevision: 0,
          },
          authority,
          () => true,
        ),
      ).rejects.toThrow('Assessment not found');
      const published = await module.publish(
        'session-a',
        'turn-a',
        {
          expectedAnswer: binding,
          publicationId: 'publication-a',
          bundle: bundle(),
          claimId: 'answer.supported',
          expectedRevision: 0,
        },
        authority,
        () => true,
      );
      expect(published).toEqual({
        sessionId: 'session-a',
        turnId: 'turn-a',
        revision: 1,
        active: true,
      });
      const assessed = await module.readExactAnswerAssessment({
        authorizedAnswer: answer,
        authority,
      });
      expect(assessed).toMatchObject({
        state: 'available',
        value: {
          ref: { claimId: 'answer.supported' },
          policy: {
            id: 'product.answer.llm-answer-policy/v1',
            satisfied: true,
          },
        },
      });
      await expect(
        module.publish(
          'session-a',
          'turn-a',
          {
            expectedAnswer: {
              ...binding,
              answer: {
                ...binding.answer,
                messageId: 'same-text-different-id',
              },
            },
            publicationId: 'publication-b',
            bundle: bundle(),
            claimId: 'answer.supported',
            expectedRevision: 1,
          },
          authority,
          () => true,
        ),
      ).rejects.toThrow('Assessment not found');
      await expect(
        module.remove('session-a', 'turn-a', 1, authority, () => true),
      ).resolves.toEqual({
        sessionId: 'session-a',
        turnId: 'turn-a',
        revision: 2,
        active: false,
      });
      await expect(
        module.publish(
          'session-a',
          'turn-a',
          {
            expectedAnswer: binding,
            publicationId: 'publication-c',
            bundle: bundle(),
            claimId: 'answer.supported',
            expectedRevision: 0,
          },
          authority,
          () => true,
        ),
      ).rejects.toThrow('Assessment revision conflicts');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('drops a captured assessment when R+1 commits during reauthorization', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-assessment-race-'));
    let holdReread = false;
    let enteredReread: (() => void) | undefined;
    let releaseReread: (() => void) | undefined;
    const rereadStarted = new Promise<void>((resolve) => {
      enteredReread = resolve;
    });
    const rereadReleased = new Promise<void>((resolve) => {
      releaseReread = resolve;
    });
    const module = new AnswerAssessmentModule(home, {
      read: async () => {
        if (holdReread) {
          holdReread = false;
          enteredReread!();
          await rereadReleased;
        }
        return answer;
      },
    });
    try {
      await module.publish(
        'session-a',
        'turn-a',
        {
          expectedAnswer: binding,
          publicationId: 'publication-r1',
          bundle: bundle(),
          claimId: 'answer.supported',
          expectedRevision: 0,
        },
        authority,
        () => true,
      );

      holdReread = true;
      const reading = module.readExactAnswerAssessment({
        authorizedAnswer: answer,
        authority,
      });
      await rereadStarted;
      await module.publish(
        'session-a',
        'turn-a',
        {
          expectedAnswer: binding,
          publicationId: 'publication-r2',
          bundle: bundle(),
          claimId: 'answer.supported',
          expectedRevision: 1,
        },
        authority,
        () => true,
      );
      releaseReread!();

      await expect(reading).resolves.toMatchObject({ state: 'unavailable' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('rejects a reviewed-source association with a non-Fieldwork owner', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-assessment-owner-'));
    const module = new AnswerAssessmentModule(home, {
      read: async () => answer,
    });
    try {
      await expect(
        module.publish(
          'session-a',
          'turn-a',
          {
            expectedAnswer: binding,
            publicationId: 'publication-owner',
            bundle: bundle(),
            claimId: 'answer.supported',
            expectedRevision: 0,
            reviewedSource: {
              version: 'station.reviewed-source-association/v1',
              pluginName: 'fieldwork-review',
              sourceClaimId: 'source-claim',
              sourceEvidenceId: 'source-evidence',
              answerClaimId: 'answer.supported',
              answerCitationEvidenceId: 'answer-citation',
              owner: '@kontourai/not-fieldwork',
              runId: 'run-a',
              exactRef: 'fieldwork-reviewed-source:v1:abc',
              assessmentRevision: 1,
              projectId: 'project-a',
              workspaceId: 'workspace-a',
              principalId: 'local:owner',
            },
          },
          authority,
          () => true,
        ),
      ).rejects.toThrow('Assessment revision conflicts');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('treats reviewed-source association bytes as part of publication idempotency', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-assessment-idempotency-'));
    const module = new AnswerAssessmentModule(home, {
      read: async () => answer,
    });
    const reviewedSource = {
      version: 'station.reviewed-source-association/v1' as const,
      pluginName: 'fieldwork-review',
      sourceClaimId: 'source-claim',
      sourceEvidenceId: 'source-evidence',
      answerClaimId: 'answer.supported',
      answerCitationEvidenceId: 'answer-citation',
      owner: '@kontourai/fieldwork',
      runId: 'run-a',
      exactRef: 'fieldwork-reviewed-source:v1:abc',
      assessmentRevision: 1,
      projectId: 'project-a',
      workspaceId: 'workspace-a',
      principalId: 'personal:owner',
    };
    const input = {
      expectedAnswer: binding,
      publicationId: 'publication-same',
      bundle: bundle(),
      claimId: 'answer.supported',
      expectedRevision: 0,
      reviewedSource,
    };
    try {
      await expect(
        module.publish('session-a', 'turn-a', input, authority, () => true),
      ).resolves.toMatchObject({ revision: 1 });
      await expect(
        module.publish('session-a', 'turn-a', input, authority, () => true),
      ).resolves.toMatchObject({ revision: 1 });
      await expect(
        module.publish(
          'session-a',
          'turn-a',
          {
            ...input,
            reviewedSource: {
              ...reviewedSource,
              exactRef: 'fieldwork-reviewed-source:v1:changed',
            },
          },
          authority,
          () => true,
        ),
      ).rejects.toThrow('Assessment publication conflicts');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
