import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileStorageNotFoundError } from '../../../domain/project-file-transactions.js';
import { FeaturePreviewRegistry } from '../../../services/feature-previews/feature-preview-registry.js';
import { createProjectCheckoutFreshnessReader } from '../../../services/projects/project-checkout-freshness.js';
import { execGitSync } from '../../../utils/git-exec.js';
import { createLogger } from '../../../utils/logger.js';
import { createProjectRoutes } from '../projects.js';

const temp = trackTempDirs();

function git(cwd: string, args: string[]) {
  execGitSync(
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { cwd, hardening: { allowFileProtocol: true } },
  );
}

/** A Project checkout four commits behind its fetched upstream. */
function checkoutBehind(): string {
  const root = temp('station-freshness-route-');
  const upstream = join(root, 'upstream.git');
  const other = join(root, 'other');
  const checkout = join(root, 'checkout');
  git(root, ['init', '-q', '--bare', '-b', 'main', upstream]);
  git(root, ['clone', '-q', upstream, other]);
  git(other, ['checkout', '-q', '-b', 'main']);
  git(other, ['commit', '-q', '--allow-empty', '-m', 'first']);
  git(other, ['push', '-q', 'origin', 'main']);
  git(root, ['clone', '-q', upstream, checkout]);
  for (let i = 0; i < 4; i += 1)
    git(other, ['commit', '-q', '--allow-empty', '-m', `next ${i}`]);
  git(other, ['push', '-q', 'origin', 'main']);
  git(checkout, ['fetch', '-q']);
  return checkout;
}

async function routes(options: {
  enabled: boolean;
  member?: boolean;
  workingDirectory: string;
}) {
  const home = temp('station-freshness-home-');
  const previews = new FeaturePreviewRegistry(
    home,
    createLogger({ name: 'preview-test', level: 'error' }),
  );
  const preview = previews.bind({
    id: 'stale-project-checkout',
    label: 'Stale checkout warning',
    description: 'test',
  });
  if (options.enabled)
    await previews.setEnabled('stale-project-checkout', true);
  const reader = createProjectCheckoutFreshnessReader();
  const project = {
    id: 'id-1',
    slug: 'atlas',
    name: 'Atlas',
    workingDirectory: options.workingDirectory,
  };
  const service = {
    getProject: (slug: string) => {
      if (slug !== 'atlas')
        throw new FileStorageNotFoundError(`Project ${slug} not found`);
      return project;
    },
  };
  const app = createProjectRoutes(service as never, {} as never, home, {
    checkoutFreshness: {
      preview,
      read: (p) => reader.read(p.workingDirectory, { commits: 3, days: 30 }),
    },
    ...(options.member
      ? {
          memberProjectAdmission: async () => ({
            scope: { localProjectId: 'id-1' } as never,
            actions: ['view'] as never,
          }),
        }
      : {}),
  });
  return { app, previews };
}

describe('GET /api/projects/:slug/checkout-freshness', () => {
  test('answers the checkout’s freshness from its real git refs when the preview is on', async () => {
    const checkout = checkoutBehind();
    const { app } = await routes({ enabled: true, workingDirectory: checkout });
    const res = await app.request('/atlas/checkout-freshness');
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({
      version: 'station.project-checkout-freshness/v1',
      status: 'stale',
      staleBecause: ['commits'],
      branch: 'main',
      upstream: 'origin/main',
      behind: 4,
      updateCommand: `git -C ${process.platform === 'win32' ? `'${checkout}'` : checkout} pull --ff-only`,
    });
  });

  test('refuses with the preview discriminant, and reads no git, while the preview is off', async () => {
    const { app } = await routes({
      enabled: false,
      // Were the reader reached, this would answer `missing-directory`.
      workingDirectory: '/definitely/not/here',
    });
    const res = await app.request('/atlas/checkout-freshness');
    expect(res.status).toBe(404);
    expect(await json(res)).toMatchObject({
      success: false,
      code: 'feature_preview_disabled',
      previewId: 'stale-project-checkout',
      settingsPath:
        '/settings?view=feature-previews&highlight=feature-previews',
    });
  });

  test('a choice changed after composition applies to the next read', async () => {
    const checkout = checkoutBehind();
    const { app, previews } = await routes({
      enabled: false,
      workingDirectory: checkout,
    });
    expect((await app.request('/atlas/checkout-freshness')).status).toBe(404);
    await previews.setEnabled('stale-project-checkout', true);
    expect((await app.request('/atlas/checkout-freshness')).status).toBe(200);
  });

  test('a shared member and an unknown Project are both answered not found', async () => {
    const checkout = checkoutBehind();
    const member = await routes({
      enabled: true,
      member: true,
      workingDirectory: checkout,
    });
    const refused = await member.app.request('/atlas/checkout-freshness');
    expect(refused.status).toBe(404);
    expect(await json(refused)).toEqual({
      success: false,
      error: 'Project not found',
    });
    const owner = await routes({ enabled: true, workingDirectory: checkout });
    expect(
      (await owner.app.request('/missing/checkout-freshness')).status,
    ).toBe(404);
  });

  test('a working directory outside any repository is unknown, not an error', async () => {
    const plain = temp('station-freshness-plain-');
    const { app } = await routes({ enabled: true, workingDirectory: plain });
    const res = await app.request('/atlas/checkout-freshness');
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({
      status: 'unknown',
      reason: 'not-a-repository',
    });
  });
});
