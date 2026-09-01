import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { buildAnswerCardProjection } from '@kontourai/surface';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { stationAnswerAssessmentClaimProfile } from '../station-answer-assessment-profile.js';
import {
  answerSupportReadOpenFlags,
  CanonicalProjectTrustReportReader,
  enumerateOwnedAncestors,
  PERSONAL_PROJECT_TRUST_CAPABILITY,
  TaskAnswerSupportConflictError,
  TaskAnswerSupportModule,
  TaskAnswerSupportStore,
  TaskAnswerSupportUnavailableError,
} from '../task-answer-support-module.js';

const directories: string[] = [];
const storedBundleId = 'sb1.WyJ3b3Jrc3BhY2UiLCIiLCIiLCJhLmpzb24iXQ';
// The imported Surface example was observed on August 25 and remains valid for
// seven days. Freeze only Date so this policy assertion keeps testing that
// intended temporal relationship instead of the wall clock running the suite.
const SURFACE_POLICY_OBSERVATION_TIME = '2026-08-26T00:00:03.000Z';

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function bundle(claim = 'claim-a') {
  return {
    schemaVersion: 5,
    source: 'test',
    claims: [
      {
        id: claim,
        subjectType: 'artifact',
        subjectId: 'repo:demo',
        facet: 'quality',
        claimType: 'quality.test',
        fieldOrBehavior: 'test',
        value: 'pass',
        status: 'verified',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    evidence: [],
    policies: [],
    events: [],
  };
}

describe('TaskAnswerSupportStore', () => {
  const input = {
    taskId: 'task-a',
    answerReferenceId: 'reference-a',
    sessionId: 'session-a',
    turnId: 'turn-a',
    projectSlug: 'project-a',
    bundleId: storedBundleId,
    claimId: 'claim-a',
  };
  test('persists natural-key idempotency, CAS replay, and deletion across restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-answer-support-'));
    directories.push(home);
    const store = new TaskAnswerSupportStore(home);
    const first = await store.create(input);
    expect((await store.create(input)).id).toBe(first.id);
    await expect(
      store.create({ ...input, claimId: 'claim-b' }),
    ).rejects.toBeInstanceOf(TaskAnswerSupportConflictError);
    const replaced = await store.replace({
      ...input,
      claimId: 'claim-b',
      expectedRevision: 1,
    });
    expect(replaced.revision).toBe(2);
    expect(
      (
        await new TaskAnswerSupportStore(home).replace({
          ...input,
          claimId: 'claim-b',
          expectedRevision: 1,
        })
      ).revision,
    ).toBe(2);
    await store.remove(input.taskId, input.answerReferenceId, 2);
    await store.remove(input.taskId, input.answerReferenceId, 2);
    expect(await store.readForTask(input.taskId)).toEqual([]);
  });

  test('fails closed on strict corruption', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-answer-support-'));
    directories.push(home);
    const dir = join(home, 'task-answer-support');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'index.json'),
      '{"schemaVersion":1,"records":[{}]}',
    );
    await expect(
      new TaskAnswerSupportStore(home).readForTask('task-a'),
    ).rejects.toBeInstanceOf(TaskAnswerSupportUnavailableError);
  });

  test('rejects a persisted Task over the per-Task association capacity without rewriting it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-answer-support-'));
    directories.push(home);
    const dir = join(home, 'task-answer-support');
    mkdirSync(dir);
    const records = Array.from({ length: 101 }, (_, index) => ({
      schemaVersion: 1,
      kind: 'answer-support',
      id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
      taskId: 'task-a',
      answerReferenceId: `reference-${index}`,
      revision: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sessionId: 'session-a',
      turnId: 'turn-a',
      projectSlug: 'project-a',
      bundleId: storedBundleId,
      claimId: 'claim-a',
    }));
    const indexPath = join(dir, 'index.json');
    const bytes = JSON.stringify({ schemaVersion: 1, records });
    writeFileSync(indexPath, bytes);
    await expect(
      new TaskAnswerSupportStore(home).readForTask('task-a'),
    ).rejects.toBeInstanceOf(TaskAnswerSupportUnavailableError);
    expect(readFileSync(indexPath, 'utf8')).toBe(bytes);
  });

  test('refuses a symlinked Station-owned index rather than following it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-answer-support-'));
    const outside = mkdtempSync(join(tmpdir(), 'station-answer-outside-'));
    directories.push(home, outside);
    mkdirSync(join(home, 'task-answer-support'));
    writeFileSync(
      join(outside, 'index.json'),
      '{"schemaVersion":1,"records":[]}',
    );
    symlinkSync(
      join(outside, 'index.json'),
      join(home, 'task-answer-support', 'index.json'),
    );
    await expect(
      new TaskAnswerSupportStore(home).readForTask('task-a'),
    ).rejects.toBeInstanceOf(TaskAnswerSupportUnavailableError);
  });

  test('persists exact portable opaque IDs and rejects stale CAS replay or anchor rewrites', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-answer-support-'));
    directories.push(home);
    const store = new TaskAnswerSupportStore(home);
    const portable = {
      ...input,
      answerReferenceId: 'reference/with\\separators\u0000and-nul',
      sessionId: `session/with\\separators\u0000and-nul-${'s'.repeat(1_000)}`,
      turnId: 'turn/with\\separators\u0000and-nul',
      claimId: 'c'.repeat(1_000),
    };
    await store.create(portable);
    expect(
      await new TaskAnswerSupportStore(home).readForTask('task-a'),
    ).toEqual([expect.objectContaining(portable)]);
    await store.replace({
      ...portable,
      claimId: 'claim-b',
      expectedRevision: 1,
    });
    await store.replace({
      ...portable,
      claimId: 'claim-c',
      expectedRevision: 2,
    });
    await expect(
      store.replace({ ...portable, claimId: 'claim-b', expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(TaskAnswerSupportConflictError);
    await expect(
      store.create({
        ...portable,
        answerReferenceId: 'r'.repeat(4_097),
      }),
    ).rejects.toBeInstanceOf(TaskAnswerSupportUnavailableError);
    await expect(
      store.replace({
        ...portable,
        sessionId: 'rewritten-session',
        claimId: 'claim-d',
        expectedRevision: 3,
      }),
    ).rejects.toBeInstanceOf(TaskAnswerSupportConflictError);
  });

  test('handles short writes and fails closed on temp replacement or post-rename readback uncertainty', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-answer-support-'));
    directories.push(home);
    const shortWriter = new TaskAnswerSupportStore(home, {
      write: (fd, bytes, offset, length, position) =>
        writeSync(fd, bytes, offset, Math.min(length, 7), position),
    });
    await shortWriter.create(input);
    expect(
      (await new TaskAnswerSupportStore(home).readForTask('task-a'))[0],
    ).toMatchObject(input);

    const prior = readFileSync(
      join(home, 'task-answer-support', 'index.json'),
      'utf8',
    );
    const replacement = new TaskAnswerSupportStore(home, {
      afterTempClose: (temp) => {
        renameSync(temp, `${temp}.moved`);
        symlinkSync(join(home, 'outside.json'), temp);
      },
    });
    await expect(
      replacement.create({ ...input, answerReferenceId: 'reference-b' }),
    ).rejects.toBeInstanceOf(TaskAnswerSupportUnavailableError);
    expect(
      readFileSync(join(home, 'task-answer-support', 'index.json'), 'utf8'),
    ).toBe(prior);

    const uncertain = new TaskAnswerSupportStore(home, {
      afterRename: () => {
        throw new Error('post-rename transport uncertainty');
      },
    });
    await expect(
      uncertain.create({ ...input, answerReferenceId: 'reference-c' }),
    ).rejects.toBeInstanceOf(TaskAnswerSupportUnavailableError);
    const reconstructed = new TaskAnswerSupportStore(home);
    expect(await reconstructed.readForTask('task-a')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ answerReferenceId: 'reference-c' }),
      ]),
    );
    await expect(
      reconstructed.create({ ...input, answerReferenceId: 'reference-c' }),
    ).resolves.toEqual(
      expect.objectContaining({ answerReferenceId: 'reference-c' }),
    );
  });
});

describe('CanonicalProjectTrustReportReader', () => {
  test('only treats a real policy-satisfied answer bundle as an assessment when its claim has the exact answer profile', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(SURFACE_POLICY_OBSERVATION_TIME);
    const root = mkdtempSync(join(tmpdir(), 'station-answer-reader-'));
    directories.push(root);
    const bundleDir = join(root, '.station', 'trust-bundles');
    mkdirSync(bundleDir, { recursive: true });
    const raw = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          'node_modules/@kontourai/surface/examples/answer-provenance.json',
        ),
        'utf8',
      ),
    );
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
    const qualified = structuredClone(raw);
    Object.assign(
      qualified.claims.find(
        (claim: { id: string }) => claim.id === 'answer.supported',
      ),
      stationAnswerAssessmentClaimProfile(binding),
    );
    const wrongAnswer = structuredClone(qualified);
    Object.assign(
      wrongAnswer.claims.find(
        (claim: { id: string }) => claim.id === 'answer.supported',
      ),
      stationAnswerAssessmentClaimProfile({
        ...binding,
        answer: { ...binding.answer, messageId: 'message-b' },
      }),
    );
    writeFileSync(join(bundleDir, 'legacy.json'), JSON.stringify(raw));
    writeFileSync(join(bundleDir, 'wrong.json'), JSON.stringify(wrongAnswer));
    writeFileSync(join(bundleDir, 'qualified.json'), JSON.stringify(qualified));
    const reader = new CanonicalProjectTrustReportReader(
      () => ({ workspacePath: root }),
      PERSONAL_PROJECT_TRUST_CAPABILITY,
    );
    const choices = await reader.listBundles('project-a');
    const assessments = await Promise.all(
      choices.map(async ({ id }) => ({
        id,
        assessment: await reader.readAssessment(
          'project-a',
          id,
          'answer.supported',
          binding,
        ),
      })),
    );
    expect(
      assessments.filter(({ assessment }) => assessment.state === 'available'),
    ).toHaveLength(1);
    expect(
      assessments.filter(
        ({ assessment }) => assessment.state === 'unsupported-version',
      ),
    ).toHaveLength(2);
    const positive = assessments.find(
      ({ assessment }) => assessment.state === 'available',
    )!;
    expect(positive.assessment).toMatchObject({
      value: {
        ref: { bundleId: positive.id, claimId: 'answer.supported' },
        policy: { id: 'product.answer.llm-answer-policy/v1', satisfied: true },
      },
    });
    await expect(
      reader.readAssessment(
        'project-a',
        positive.id,
        'answer.supported',
        binding,
      ),
    ).resolves.toMatchObject({
      state: 'available',
      value: { ref: { bundleId: positive.id } },
    });
    const legacy = assessments.find(
      ({ assessment }) => assessment.state === 'unsupported-version',
    )!;
    await expect(
      reader.readClaim('project-a', legacy.id, 'answer.supported'),
    ).resolves.toMatchObject({ state: 'found' });
  });

  test('enumerates win32 drive and UNC ancestors from their true parsed roots', () => {
    const flavor = {
      resolve: win32.resolve,
      parse: win32.parse,
      join: win32.join,
      sep: win32.sep,
    };
    expect(
      enumerateOwnedAncestors('C:\\Users\\brian\\basis.json', flavor),
    ).toEqual([
      'C:\\',
      'C:\\Users',
      'C:\\Users\\brian',
      'C:\\Users\\brian\\basis.json',
    ]);
    expect(
      enumerateOwnedAncestors('\\\\server\\share\\trust\\basis.json', flavor),
    ).toEqual([
      '\\\\server\\share\\',
      '\\\\server\\share\\trust',
      '\\\\server\\share\\trust\\basis.json',
    ]);
  });

  test('no-O_NOFOLLOW fallback retains the post-open identity guard', async () => {
    expect(answerSupportReadOpenFlags(null)).toBe(0);
    const root = mkdtempSync(join(tmpdir(), 'station-answer-reader-'));
    directories.push(root);
    const bundleDir = join(root, '.station', 'trust-bundles');
    mkdirSync(bundleDir, { recursive: true });
    const source = join(bundleDir, 'basis.json');
    const replacement = join(bundleDir, 'basis.replacement.json');
    writeFileSync(source, JSON.stringify(bundle()));
    writeFileSync(replacement, JSON.stringify(bundle('changed')));
    const reader = new CanonicalProjectTrustReportReader(
      () => ({ workspacePath: root }),
      PERSONAL_PROJECT_TRUST_CAPABILITY,
      {
        noFollow: null,
        // The open descriptor keeps the original inode while the pathname now
        // names a different generation. An in-place same-size rewrite can
        // legitimately coalesce every metadata field on fast filesystems.
        afterOpen: () => renameSync(replacement, source),
      },
    );
    const [choice] = await reader.listBundles('project-a');
    expect(
      (await reader.readClaim('project-a', choice.id, 'claim-a')).state,
    ).toBe('unavailable');
  });

  test('normalizes initial disappearance and access loss before bytes are read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-answer-reader-'));
    directories.push(root);
    const bundleDir = join(root, '.station', 'trust-bundles');
    mkdirSync(bundleDir, { recursive: true });
    const source = join(bundleDir, 'basis.json');
    writeFileSync(source, JSON.stringify(bundle()));
    const disappearing = new CanonicalProjectTrustReportReader(
      () => ({ workspacePath: root }),
      PERSONAL_PROJECT_TRUST_CAPABILITY,
      { beforeRead: () => rmSync(source) },
    );
    const [choice] = await disappearing.listBundles('project-a');
    expect(
      (await disappearing.readClaim('project-a', choice.id, 'claim-a')).state,
    ).toBe('unavailable');

    writeFileSync(source, JSON.stringify(bundle()));
    const denied = new CanonicalProjectTrustReportReader(
      () => ({ workspacePath: root }),
      PERSONAL_PROJECT_TRUST_CAPABILITY,
      {
        beforeRead: () => {
          const error = Object.assign(new Error('denied'), { code: 'EACCES' });
          throw error;
        },
      },
    );
    const [deniedChoice] = await denied.listBundles('project-a');
    expect(
      (await denied.readClaim('project-a', deniedChoice.id, 'claim-a')).state,
    ).toBe('unavailable');
  });

  test('source-qualified opaque IDs keep same-name workspace and plugin bundles distinct', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-answer-reader-'));
    directories.push(root);
    const plugins = join(root, 'plugins');
    mkdirSync(join(root, '.station', 'trust-bundles'), { recursive: true });
    mkdirSync(join(plugins, 'one', 'trust-bundles'), { recursive: true });
    writeFileSync(
      join(root, '.station', 'trust-bundles', 'same.json'),
      JSON.stringify(bundle('workspace-claim')),
    );
    writeFileSync(
      join(plugins, 'one', 'trust-bundles', 'same.json'),
      JSON.stringify(bundle('plugin-claim')),
    );
    const reader = new CanonicalProjectTrustReportReader(
      (slug) =>
        slug === 'project-a'
          ? { workspacePath: root, pluginDataDir: plugins }
          : undefined,
      PERSONAL_PROJECT_TRUST_CAPABILITY,
    );
    const choices = await reader.listBundles('project-a');
    expect(choices).toHaveLength(2);
    expect(choices[0].id).not.toBe(choices[1].id);
    expect(
      (
        (await reader.listClaims('project-a', choices[0].id)) as Array<{
          id: string;
        }>
      ).map((claim) => claim.id),
    ).not.toEqual(
      (
        (await reader.listClaims('project-a', choices[1].id)) as Array<{
          id: string;
        }>
      ).map((claim) => claim.id),
    );
    expect(await reader.listClaims('project-a', `${choices[0].id}=`)).toBe(
      'not-found',
    );
  });

  test('distinguishes current and legacy Veritas files with the same filename', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-answer-reader-'));
    directories.push(root);
    const current = join(root, 'current');
    const legacy = join(root, 'legacy');
    mkdirSync(current);
    mkdirSync(legacy);
    writeFileSync(
      join(current, 'veritas-run.json'),
      JSON.stringify({ trust: { bundle: bundle('current') } }),
    );
    writeFileSync(
      join(legacy, 'veritas-run.json'),
      JSON.stringify({ trust: { bundle: bundle('legacy') } }),
    );
    const reader = new CanonicalProjectTrustReportReader(
      () => ({ veritasEvidenceDir: [current, legacy] }),
      PERSONAL_PROJECT_TRUST_CAPABILITY,
    );
    const choices = await reader.listBundles('project-a');
    expect(choices).toHaveLength(2);
    expect(choices[0].id).not.toBe(choices[1].id);
    expect(
      (
        (await reader.listClaims('project-a', choices[0].id)) as Array<{
          id: string;
        }>
      ).map((item) => item.id),
    ).not.toEqual(
      (
        (await reader.listClaims('project-a', choices[1].id)) as Array<{
          id: string;
        }>
      ).map((item) => item.id),
    );
  });

  test('treats an authorized project with no source files as empty but an enumeration failure as unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-answer-reader-'));
    directories.push(root);
    const reader = new CanonicalProjectTrustReportReader(
      () => ({ workspacePath: root }),
      PERSONAL_PROJECT_TRUST_CAPABILITY,
    );
    await expect(reader.listBundles('project-a')).resolves.toEqual([]);
    // A non-directory at the owned intermediate is an infrastructure fault,
    // not an authorized absence of bundle candidates.
    writeFileSync(join(root, '.station'), 'not a directory');
    await expect(reader.listBundles('project-a')).rejects.toBeInstanceOf(
      TaskAnswerSupportUnavailableError,
    );
  });

  test('fails closed on directory overflow and ignores regular files in the plugin root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-answer-reader-'));
    directories.push(root);
    const plugins = join(root, 'plugins');
    mkdirSync(plugins);
    writeFileSync(join(plugins, 'ordinary-file'), 'not a plugin directory');
    mkdirSync(join(plugins, 'plugin-a', 'trust-bundles'), { recursive: true });
    writeFileSync(
      join(plugins, 'plugin-a', 'trust-bundles', 'basis.json'),
      JSON.stringify(bundle()),
    );
    const reader = new CanonicalProjectTrustReportReader(
      () => ({ pluginDataDir: plugins }),
      PERSONAL_PROJECT_TRUST_CAPABILITY,
    );
    await expect(reader.listBundles('project-a')).resolves.toHaveLength(1);
    for (let index = 0; index <= 100; index++)
      writeFileSync(join(plugins, `extra-${index}`), 'x');
    await expect(reader.listBundles('project-a')).rejects.toBeInstanceOf(
      TaskAnswerSupportUnavailableError,
    );
  });

  test('never emits an undecodable bundle ID for a long plugin and filename tuple', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-answer-reader-'));
    directories.push(root);
    const plugins = join(root, 'plugins');
    const plugin = 'p'.repeat(200);
    const file = `${'f'.repeat(200)}.json`;
    mkdirSync(join(plugins, plugin, 'trust-bundles'), { recursive: true });
    writeFileSync(
      join(plugins, plugin, 'trust-bundles', file),
      JSON.stringify(bundle()),
    );
    const reader = new CanonicalProjectTrustReportReader(
      () => ({ pluginDataDir: plugins }),
      PERSONAL_PROJECT_TRUST_CAPABILITY,
    );
    await expect(reader.listBundles('project-a')).rejects.toBeInstanceOf(
      TaskAnswerSupportUnavailableError,
    );
  });

  test('rejects final-file replacement after open and intermediate replacement after read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-answer-reader-'));
    directories.push(root);
    const bundleDir = join(root, '.station', 'trust-bundles');
    mkdirSync(bundleDir, { recursive: true });
    const source = join(bundleDir, 'basis.json');
    writeFileSync(source, JSON.stringify(bundle()));
    const finalReader = new CanonicalProjectTrustReportReader(
      () => ({ workspacePath: root }),
      PERSONAL_PROJECT_TRUST_CAPABILITY,
      {
        afterOpen: () =>
          writeFileSync(source, JSON.stringify(bundle('replacement'))),
      },
    );
    const [choice] = await finalReader.listBundles('project-a');
    expect(
      (await finalReader.readClaim('project-a', choice.id, 'claim-a')).state,
    ).toBe('unavailable');

    writeFileSync(source, JSON.stringify(bundle()));
    const oldDirectory = `${bundleDir}-old`;
    const intermediateReader = new CanonicalProjectTrustReportReader(
      () => ({ workspacePath: root }),
      PERSONAL_PROJECT_TRUST_CAPABILITY,
      {
        afterRead: () => {
          renameSync(bundleDir, oldDirectory);
          mkdirSync(bundleDir);
          writeFileSync(
            join(bundleDir, 'basis.json'),
            JSON.stringify(bundle('replacement')),
          );
        },
      },
    );
    const [intermediateChoice] =
      await intermediateReader.listBundles('project-a');
    expect(
      (
        await intermediateReader.readClaim(
          'project-a',
          intermediateChoice.id,
          'claim-a',
        )
      ).state,
    ).toBe('unavailable');
  });
});

describe('TaskAnswerSupportModule Surface projection boundary', () => {
  const authority = {} as never;
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
  const anchor = {
    taskId: 'task-a',
    referenceId: 'reference-a',
    projectSlug: 'project-a',
    sessionId: 'session-a',
    turnId: 'turn-a',
    binding,
  };
  const claim = (overrides: Record<string, unknown> = {}) => ({
    id: 'claim-a',
    subjectType: 'artifact',
    subjectId: 'repo:demo',
    claimType: 'quality.test',
    fieldOrBehavior: 'test',
    value: 'pass',
    status: 'verified',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
  const evidence = (overrides: Record<string, unknown> = {}) => ({
    id: 'evidence-a',
    claimId: 'claim-a',
    evidenceType: 'test_output',
    method: 'validation',
    sourceRef: 'surface-fixture',
    excerptOrSummary: 'fixture',
    observedAt: '2026-01-01T00:00:00.000Z',
    collectedBy: 'fixture',
    ...overrides,
  });
  const report = (input: Record<string, unknown> = {}) => ({
    claims: [claim()],
    evidence: [],
    transparencyGaps: [],
    ...input,
  });
  async function moduleFor(current: ReturnType<typeof report>) {
    const home = mkdtempSync(join(tmpdir(), 'station-answer-semantic-'));
    directories.push(home);
    const reader = {
      listBundles: async () => [{ id: storedBundleId }],
      listClaims: async () => [{ id: 'claim-a' }],
      readClaim: async (_project: string, _bundle: string, claimId: string) => {
        const card = buildAnswerCardProjection(current as never, claimId);
        return card.found
          ? { state: 'found' as const, card }
          : { state: 'claim-missing' as const };
      },
      readAssessment: async () => ({
        owner: { authority: '@kontourai/surface' as const },
        state: 'not-captured' as const,
        observedAt: '2026-08-26T00:00:00.000Z',
      }),
    };
    const module = new TaskAnswerSupportModule({
      anchors: { authorize: async () => anchor },
      reports: reader,
      store: new TaskAnswerSupportStore(home),
    });
    return module;
  }
  async function associate(module: TaskAnswerSupportModule) {
    return module.create(
      anchor.taskId,
      anchor.referenceId,
      storedBundleId,
      'claim-a',
      authority,
    );
  }

  test('delegates every current semantic card facet to published Surface without inferring an association', async () => {
    const current = report({
      claims: [
        claim({
          status: 'stale',
          freshness: {
            asOf: '2026-01-01T00:00:00.000Z',
            expiresAt: '2025-01-01T00:00:00.000Z',
            stale: true,
          },
          derivedFrom: ['missing-direct-input'],
        }),
      ],
      evidence: [
        evidence({
          id: 'cited-failed',
          supportStrength: 'cited',
          passing: false,
        }),
        evidence({
          id: 'entails-failed',
          supportStrength: 'entails',
          passing: false,
        }),
        evidence({
          id: 'entails-nonblocking',
          supportStrength: 'entails',
          passing: false,
          blocking: false,
        }),
      ],
      transparencyGaps: [
        {
          id: 'gap-a',
          claimId: 'claim-a',
          type: 'provenance_gap',
          severity: 'high',
          message: 'missing direct provenance',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const module = await moduleFor(current);
    // None of these facts—matching answer text, a task output, cited evidence,
    // project membership, or a newer bundle—can synthesize the authored join.
    expect(
      await module.standing(anchor.taskId, anchor.referenceId, authority),
    ).toEqual({ state: 'unassessed' });
    await associate(module);
    const standing = await module.standing(
      anchor.taskId,
      anchor.referenceId,
      authority,
    );
    expect(standing).toMatchObject({ state: 'available' });
    if (standing.state !== 'available') throw new Error('expected card');
    expect(standing.card.claim.status).toBe('stale');
    expect(standing.card.claim.freshness).toMatchObject({ stale: true });
    expect(standing.card.evidence.cited).toEqual([
      expect.objectContaining({
        id: 'cited-failed',
        result: 'failed',
        blocksClaim: false,
      }),
    ]);
    expect(standing.card.evidence.entailing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'entails-failed',
          result: 'failed',
          blocksClaim: true,
        }),
        expect.objectContaining({
          id: 'entails-nonblocking',
          result: 'failed',
          blocksClaim: false,
        }),
      ]),
    );
    expect(standing.card.derivation).toEqual({
      available: true,
      directInputs: [
        expect.objectContaining({
          claimId: 'missing-direct-input',
          status: null,
        }),
      ],
    });
    expect(standing.card.transparencyGaps).toHaveLength(1);
  });

  test('passes the reauthorized exact binding to the Task-local assessment reader', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-answer-semantic-'));
    directories.push(home);
    const readAssessment = vi.fn(async () => ({
      owner: { authority: '@kontourai/surface' as const },
      state: 'unsupported-version' as const,
      observedAt: '2026-08-26T00:00:00.000Z',
    }));
    const module = new TaskAnswerSupportModule({
      anchors: { authorize: async () => anchor },
      reports: {
        readClaim: async () => ({
          state: 'found' as const,
          card: buildAnswerCardProjection(
            report() as never,
            'claim-a',
          ) as never,
        }),
        readAssessment,
      } as never,
      store: new TaskAnswerSupportStore(home),
    });
    await associate(module);
    await expect(
      module.assessment(anchor.taskId, anchor.referenceId, authority),
    ).resolves.toMatchObject({ state: 'unsupported-version' });
    expect(readAssessment).toHaveBeenCalledWith(
      anchor.projectSlug,
      storedBundleId,
      'claim-a',
      binding,
    );
  });

  test('keeps a qualified Task override local, then restores the producer path when removed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-answer-semantic-'));
    directories.push(home);
    const anchors = {
      authorize: async (taskId: string, referenceId: string) => ({
        ...anchor,
        taskId,
        referenceId,
      }),
    };
    const reports = {
      readClaim: async () => ({
        state: 'found' as const,
        card: buildAnswerCardProjection(report() as never, 'claim-a') as never,
      }),
      readAssessment: async () => ({
        owner: { authority: '@kontourai/surface' as const },
        state: 'available' as const,
        observedAt: '2026-08-26T00:00:00.000Z',
        value: { ref: { claimId: 'claim-a' } },
      }),
    };
    const module = new TaskAnswerSupportModule({
      anchors,
      reports: reports as never,
      store: new TaskAnswerSupportStore(home),
    });
    const producer = {
      owner: { authority: '@kontourai/surface' as const },
      state: 'not-captured' as const,
      observedAt: '2026-08-26T00:00:00.000Z',
    };
    const select = async (taskId: string) =>
      (await module.assessment(taskId, anchor.referenceId, authority)) ??
      producer;
    const association = await module.create(
      'task-a',
      anchor.referenceId,
      storedBundleId,
      'claim-a',
      authority,
    );
    await expect(select('task-a')).resolves.toMatchObject({
      state: 'available',
    });
    await expect(select('task-b')).resolves.toEqual(producer);
    await module.remove(
      'task-a',
      anchor.referenceId,
      association.revision,
      authority,
    );
    await expect(select('task-a')).resolves.toEqual(producer);
  });

  test('copies disputed status and preserves cards/gaps when Surface isolates corrupt derivation declarations', async () => {
    const module = await moduleFor(
      report({
        claims: [claim({ status: 'disputed', derivationEdges: [null] })],
        transparencyGaps: [
          {
            id: 'gap-a',
            claimId: 'claim-a',
            type: 'unsupported_inference',
            severity: 'high',
            message: 'corrupt input declaration',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    await associate(module);
    const standing = await module.standing(
      anchor.taskId,
      anchor.referenceId,
      authority,
    );
    expect(standing).toMatchObject({ state: 'available' });
    if (standing.state !== 'available') throw new Error('expected card');
    expect(standing.card.claim.status).toBe('disputed');
    expect(standing.card.derivation).toEqual({
      available: false,
      directInputs: [],
    });
    expect(standing.card.transparencyGaps).toHaveLength(1);
  });

  test('does not call a missing claim supported merely by an authorized bundle', async () => {
    const module = await moduleFor(report());
    await expect(
      module.create(
        anchor.taskId,
        anchor.referenceId,
        storedBundleId,
        'claim-missing',
        authority,
      ),
    ).rejects.toThrow('Answer support not found');
  });

  test('collapses distinct upstream anchor and report-loader denials into the same no-leak result', async () => {
    const protectedValues = [
      'project-secret',
      storedBundleId,
      'claim-secret',
      '/private/report.json',
      'excerpt-secret',
      'count=99',
    ];
    const assertNoLeak = async (module: TaskAnswerSupportModule) => {
      try {
        await module.create(
          'task-a',
          'reference-a',
          storedBundleId,
          'claim-secret',
          authority,
        );
        throw new Error('expected denial');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const outward = (error as Error).message;
        expect(outward).toBe('Answer support not found');
        for (const value of protectedValues)
          expect(outward).not.toContain(value);
      }
    };
    for (const upstream of [
      'task-missing',
      'session-missing',
      'turn-missing',
      'non-assistant',
      'incomplete-answer',
      'answer-denied',
    ]) {
      const reports = { readClaim: vi.fn() };
      const home = mkdtempSync(join(tmpdir(), `station-answer-${upstream}-`));
      directories.push(home);
      await assertNoLeak(
        new TaskAnswerSupportModule({
          anchors: { authorize: async () => 'not-found' as const },
          reports: reports as never,
          store: new TaskAnswerSupportStore(home),
        }),
      );
      expect(reports.readClaim).not.toHaveBeenCalled();
    }
    for (const loader of [
      'project-missing',
      'project-denied',
      'bundle-missing',
      'bundle-denied',
      'claim-missing',
      'claim-denied',
      'cross-project',
    ]) {
      const reports = {
        readClaim: vi.fn(async () => ({ state: 'claim-missing' as const })),
      };
      const home = mkdtempSync(join(tmpdir(), `station-answer-${loader}-`));
      directories.push(home);
      const projectSlug =
        loader === 'cross-project' ? 'project-other' : 'project-a';
      const module = new TaskAnswerSupportModule({
        anchors: {
          authorize: async () => ({ ...anchor, projectSlug }),
        },
        reports: reports as never,
        store: new TaskAnswerSupportStore(home),
      });
      await assertNoLeak(module);
      expect(reports.readClaim).toHaveBeenCalledWith(
        projectSlug,
        storedBundleId,
        'claim-secret',
      );
    }
  });
});
