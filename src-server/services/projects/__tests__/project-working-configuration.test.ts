import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createProjectWorkingConfigurationRoutes } from '../../../routes/projects/project-working-configuration-routes.js';
import { ProjectWorkingConfigurationService } from '../project-working-configuration.js';

const makeTempDir = trackTempDirs();
function fixture() {
  const home = makeTempDir('working-configuration-');
  const cwd = join(home, 'checkout');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  mkdirSync(join(cwd, 'docs'));
  mkdirSync(join(cwd, '.github/workflows'), { recursive: true });
  writeFileSync(
    join(cwd, 'AGENTS.md'),
    'Keep user edits. Read [guide](docs/work.md).',
  );
  writeFileSync(join(cwd, 'src/AGENTS.md'), 'Scoped source rule.');
  writeFileSync(join(cwd, 'docs/work.md'), 'Canonical completion guidance.');
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({
      scripts: { 'test:focused': 'do-not-run-this', build: 'also-do-not-run' },
    }),
  );
  writeFileSync(
    join(cwd, '.github/workflows/check.yml'),
    'steps:\n  - run: npm run test:focused\n',
  );
  let allowed = true;
  let projectId = 'project-1';
  let directory = cwd;
  const context = async () => ({ projectId, cwd: directory });
  const service = new ProjectWorkingConfigurationService(home, context);
  const authority = () => allowed;
  return {
    home,
    cwd,
    service,
    authority,
    revoke: () => {
      allowed = false;
    },
    replaceProject: () => {
      projectId = 'project-2';
    },
    replaceRoot: (root: string) => {
      directory = root;
    },
  };
}

test('repository discovery and reviewed apply preserve editable defaults, source provenance and a bounded focused Task context without executing declarations', async () => {
  const f = fixture();
  const view = await f.service.discover('work', f.authority);
  expect(view.sources.map((source) => source.path)).toEqual([
    '.github/workflows/check.yml',
    'AGENTS.md',
    'docs/work.md',
    'package.json',
    'src/AGENTS.md',
  ]);
  expect(view.suggested.validationCommands).toEqual([
    {
      sourcePath: '.github/workflows/check.yml',
      command: 'npm run test:focused',
    },
    { sourcePath: 'package.json', command: 'npm run test:focused' },
  ]);
  const request = {
    expectedProjectId: view.projectId,
    expectedRevision: 0,
    sourceDigest: view.sourceDigest,
    operationId: randomUUID(),
    draft: {
      ...view.suggested,
      completionCriteria: 'Keep original files; attach passing evidence.',
      checkpoints: ['Independent review'],
      evidencePointers: ['docs/work.md'],
    },
  };
  const saved = await f.service.apply('work', request, 'person-1', f.authority);
  expect(saved.revision).toBe(1);
  expect(
    (await f.service.apply('work', request, 'person-1', f.authority)).revision,
  ).toBe(1);
  const restarted = new ProjectWorkingConfigurationService(
    f.home,
    async () => ({ projectId: 'project-1', cwd: f.cwd }),
  );
  expect(
    (await restarted.discover('work', f.authority)).current?.draft
      .completionCriteria,
  ).toBe(request.draft.completionCriteria);
  const context = await restarted.forTask('work', f.authority, [
    'src/index.ts',
  ]);
  expect(context).toMatchObject({
    state: 'reviewed',
    revision: 1,
    sourceDigest: view.sourceDigest,
    omittedRules: 0,
  });
  expect(context.text).toContain('> Scoped source rule.');
  expect(context.text).toContain(
    '> Keep original files; attach passing evidence.',
  );
  expect(context.text).toContain('> docs/work.md');
  expect(context.text).toContain('not run');
  expect(context.text.length).toBeLessThanOrEqual(2400);
  const unfocused = await restarted.forTask('work', f.authority);
  expect(unfocused.omittedRules).toBe(1);
  expect(unfocused.text).not.toContain('Scoped source rule.');
  expect(readFileSync(join(f.cwd, 'package.json'), 'utf8')).toContain(
    'do-not-run-this',
  );
});

test('stale sources refuse apply and execution, while rediscovery retains reviewed edits and exact operation keys cannot name changed intent', async () => {
  const f = fixture();
  const view = await f.service.discover('work', f.authority);
  const request = {
    expectedProjectId: view.projectId,
    expectedRevision: 0,
    sourceDigest: view.sourceDigest,
    operationId: randomUUID(),
    draft: { ...view.suggested, completionCriteria: 'Person-owned acceptance' },
  };
  await f.service.apply('work', request, 'person-1', f.authority);
  await expect(
    f.service.apply(
      'work',
      {
        ...request,
        draft: {
          ...request.draft,
          completionCriteria: 'changed under same key',
        },
      },
      'person-1',
      f.authority,
    ),
  ).rejects.toMatchObject({ code: 'revision_conflict' });
  writeFileSync(join(f.cwd, 'AGENTS.md'), 'Changed repository rule.');
  await expect(
    f.service.apply(
      'work',
      { ...request, operationId: randomUUID(), expectedRevision: 1 },
      'person-1',
      f.authority,
    ),
  ).rejects.toMatchObject({ code: 'stale' });
  await expect(f.service.forTask('work', f.authority)).rejects.toMatchObject({
    code: 'stale',
  });
  const fresh = await f.service.discover('work', f.authority);
  expect(fresh.stale).toBe(true);
  expect(fresh.current?.draft.completionCriteria).toBe(
    'Person-owned acceptance',
  );
  expect(fresh.suggested.rules[0]?.text).toBe('Changed repository rule.');
});

test('revocation, replaced Project and execution root, escaping sources and oversized guidance cannot silently supply authority or context', async () => {
  const f = fixture();
  const outside = join(f.home, 'outside.md');
  writeFileSync(outside, 'PRIVATE OUTSIDE SENTINEL');
  symlinkSync(outside, join(f.cwd, 'README.md'));
  writeFileSync(join(f.cwd, 'src/AGENTS.md'), 'x'.repeat(70 * 1024));
  const view = await f.service.discover('work', f.authority);
  expect(JSON.stringify(view)).not.toContain('PRIVATE OUTSIDE SENTINEL');
  expect(view.omissions).toEqual(
    expect.arrayContaining([
      'README.md: unsafe source omitted',
      'src/AGENTS.md: source exceeds the read budget',
    ]),
  );
  const request = {
    expectedProjectId: view.projectId,
    expectedRevision: 0,
    sourceDigest: view.sourceDigest,
    operationId: randomUUID(),
    draft: view.suggested,
  };
  f.replaceProject();
  await expect(
    f.service.apply('work', request, 'person-1', f.authority),
  ).rejects.toMatchObject({ code: 'unavailable' });
  const second = fixture();
  const original = await second.service.discover('work', second.authority);
  second.replaceRoot(f.cwd);
  await expect(
    second.service.apply(
      'work',
      { ...request, sourceDigest: original.sourceDigest },
      'person-1',
      second.authority,
    ),
  ).rejects.toMatchObject({ code: 'stale' });
  second.revoke();
  await expect(
    second.service.discover('work', second.authority),
  ).rejects.toMatchObject({ code: 'unavailable' });
});

test('route preview and Project admission guard direct reads and apply; revocation before response delivery releases no configuration', async () => {
  const f = fixture();
  let enabled = false;
  let admitted = true;
  const app = createProjectWorkingConfigurationRoutes({
    service: f.service,
    enabled: () => enabled,
    authorize: async () =>
      admitted
        ? {
            projectId: 'project-1',
            actorId: 'person-1',
            isCurrent: f.authority,
          }
        : undefined,
  });
  const disabled = await app.request('/work/working-configuration');
  expect(disabled.status).toBe(404);
  expect(await disabled.json()).toMatchObject({
    code: 'feature_preview_disabled',
  });
  enabled = true;
  admitted = false;
  expect((await app.request('/work/working-configuration')).status).toBe(404);
  admitted = true;
  const response = await app.request('/work/working-configuration');
  f.revoke();
  const body = await response.text().catch(() => '');
  expect(body).not.toContain('Keep user edits');
});
