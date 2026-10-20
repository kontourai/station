import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createStationAnswerBinding,
  type StationAnswerBinding,
} from '@kontourai/station-contracts';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test } from 'vitest';
import {
  AnswerAssessmentModule,
  stationAnswerAssessmentClaimProfile,
} from '../answer-assessment-module.js';
import {
  CanonicalProjectTrustReportReader,
  PERSONAL_PROJECT_TRUST_CAPABILITY,
  TaskAnswerSupportStore,
  TaskAnswerSupportUnavailableError,
} from '../task-answer-support-module.js';

// A Station home or project root reached through a symlinked ancestor (macOS
// `/tmp` -> `/private/tmp`) used to make every kept-answer read answer
// "Answer support temporarily unavailable", because the guard refuses every
// symlinked path component. The anchor is canonicalized once where it is
// adopted; anything BELOW the anchor is still refused when it is a symlink.
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A real directory plus a sibling symlink that aliases it, like /tmp. */
function aliasedParent(): { real: string; alias: string } {
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'station-symanchor-'));
  directories.push(base);
  const real = join(base, 'real');
  mkdirSync(real);
  const alias = join(base, 'alias');
  symlinkSync(real, alias);
  return { real, alias };
}

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

function answerBundle() {
  const value = JSON.parse(
    readFileSync(
      join(
        process.cwd(),
        'node_modules/@kontourai/surface/examples/answer-provenance.json',
      ),
      'utf8',
    ),
  );
  Object.assign(value.claims[0], stationAnswerAssessmentClaimProfile(binding));
  return value;
}

function trustBundle(claim = 'claim-a') {
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

const input = {
  taskId: 'task-a',
  answerReferenceId: 'reference-a',
  sessionId: 'session-a',
  turnId: 'turn-a',
  projectSlug: 'project-a',
  bundleId: 'sb1.WyJ3b3Jrc3BhY2UiLCIiLCIiLCJhLmpzb24iXQ',
  claimId: 'claim-a',
};

describe('a Station home reached through a symlinked ancestor', () => {
  test('keeps the answer-support store working', async () => {
    const { real, alias } = aliasedParent();
    mkdirSync(join(real, 'home'));
    const store = new TaskAnswerSupportStore(join(alias, 'home'));

    const created = await store.create(input);

    expect(await store.readForTask(input.taskId)).toEqual([created]);
    // Written once, under the real directory.
    expect(
      readFileSync(
        join(real, 'home', 'task-answer-support', 'index.json'),
        'utf8',
      ),
    ).toContain(input.taskId);
  });

  test('keeps answer-assessment publish and restart reads working', async () => {
    const { real, alias } = aliasedParent();
    mkdirSync(join(real, 'home'));
    const home = join(alias, 'home');
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
          bundle: answerBundle(),
          claimId: 'answer.supported',
          expectedRevision: 0,
        },
        authority,
        () => true,
      ),
    ).resolves.toMatchObject({ revision: 1, active: true });

    expect(
      new AnswerAssessmentModule(home, {
        read: async () => answer,
      }).readTarget(answer, authority, () => true),
    ).toMatchObject({ revision: 1, active: true });
  });

  test('still refuses a home whose own final component is a symlink', async () => {
    const { real } = aliasedParent();
    mkdirSync(join(real, 'target'));
    symlinkSync(join(real, 'target'), join(real, 'home'));

    await expect(
      new TaskAnswerSupportStore(join(real, 'home')).readForTask(input.taskId),
    ).rejects.toBeInstanceOf(TaskAnswerSupportUnavailableError);
  });
});

describe('project and plugin roots reached through a symlinked ancestor', () => {
  async function readThrough(
    locations: ConstructorParameters<
      typeof CanonicalProjectTrustReportReader
    >[0],
  ) {
    const reader = new CanonicalProjectTrustReportReader(
      locations,
      PERSONAL_PROJECT_TRUST_CAPABILITY,
    );
    try {
      const [choice] = await reader.listBundles('project-a');
      return choice
        ? (await reader.readClaim('project-a', choice.id, 'claim-a')).state
        : 'no-bundle';
    } catch (error) {
      if (error instanceof TaskAnswerSupportUnavailableError)
        return 'unavailable';
      throw error;
    }
  }

  test('reads workspace, plugin-data, and Veritas evidence bundles', async () => {
    const { real, alias } = aliasedParent();
    const workspace = join(real, 'workspace');
    mkdirSync(join(workspace, '.station', 'trust-bundles'), {
      recursive: true,
    });
    writeFileSync(
      join(workspace, '.station', 'trust-bundles', 'basis.json'),
      JSON.stringify(trustBundle()),
    );
    expect(
      await readThrough(() => ({ workspacePath: join(alias, 'workspace') })),
    ).toBe('found');

    const pluginData = join(real, 'plugin-data');
    mkdirSync(join(pluginData, 'demo', 'trust-bundles'), { recursive: true });
    writeFileSync(
      join(pluginData, 'demo', 'trust-bundles', 'basis.json'),
      JSON.stringify(trustBundle()),
    );
    expect(
      await readThrough(() => ({ pluginDataDir: join(alias, 'plugin-data') })),
    ).toBe('found');

    const evidence = join(workspace, '.veritas', 'evidence');
    mkdirSync(evidence, { recursive: true });
    writeFileSync(
      join(evidence, 'veritas-run.json'),
      JSON.stringify({ trust: { bundle: trustBundle() } }),
    );
    expect(
      await readThrough(() => ({
        veritasEvidenceDir: [join(alias, 'workspace', '.veritas', 'evidence')],
      })),
    ).toBe('found');
  });

  test('still refuses a symlink BELOW the workspace anchor', async () => {
    const { real, alias } = aliasedParent();
    const workspace = join(real, 'workspace');
    const elsewhere = join(real, 'elsewhere');
    mkdirSync(join(elsewhere, 'trust-bundles'), { recursive: true });
    writeFileSync(
      join(elsewhere, 'trust-bundles', 'basis.json'),
      JSON.stringify(trustBundle()),
    );
    mkdirSync(workspace);
    symlinkSync(elsewhere, join(workspace, '.station'));

    expect(
      await readThrough(() => ({ workspacePath: join(alias, 'workspace') })),
    ).toBe('unavailable');
  });

  test('still refuses a .veritas symlink inside a workspace reached through an alias', async () => {
    const { real, alias } = aliasedParent();
    const workspace = join(real, 'workspace');
    const elsewhere = join(real, 'elsewhere');
    mkdirSync(join(elsewhere, 'evidence'), { recursive: true });
    writeFileSync(
      join(elsewhere, 'evidence', 'veritas-run.json'),
      JSON.stringify({ trust: { bundle: trustBundle() } }),
    );
    mkdirSync(workspace);
    symlinkSync(elsewhere, join(workspace, '.veritas'));

    expect(
      await readThrough(() => ({
        workspacePath: join(alias, 'workspace'),
        veritasEvidenceDir: [join(alias, 'workspace', '.veritas', 'evidence')],
      })),
    ).toBe('unavailable');
  });
});
