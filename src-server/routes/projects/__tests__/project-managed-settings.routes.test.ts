/**
 * #4517: project create and update under a managed lock, over HTTP and real
 * file storage. A refusal carries what `PUT /config/app` sends (403, `code`,
 * `key`, the organization's sentence and its real support link), and a
 * successful write answers with the record as readers see it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { summarizeManagedPolicy } from '@kontourai/station-contracts/managed-policy';
import {
  decodeManagedPolicy,
  type LoadedManagedPolicy,
  managedPolicyDigest,
} from '@kontourai/station-shared/managed-policy';
import { afterEach, describe, expect, test } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { putProject } from '../../../domain/__tests__/file-storage-test-helpers.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { installManagedAppSettings } from '../../../domain/managed-settings.js';
import { installManagedApprovalCeiling } from '../../../security/managed-approval-ceiling.js';
import { ProjectService } from '../../../services/projects/project-service.js';
import { createProjectRoutes } from '../projects.js';

const SUPPORT_URL = 'https://help.example/station';
const DENIAL = `Acme's policy manages this setting. For help, visit ${SUPPORT_URL}`;

function policy(
  settings: Record<string, { value: unknown; locked: boolean }>,
  limits?: Record<string, unknown>,
): LoadedManagedPolicy {
  const document = decodeManagedPolicy('/test/policy.json', {
    kind: 'value',
    value: {
      schemaVersion: 1,
      organization: 'Acme',
      supportUrl: SUPPORT_URL,
      settings,
      ...(limits ? { limits } : {}),
    },
  });
  return {
    source: { kind: 'test-override', location: '/test/policy.json' },
    document,
    digest: managedPolicyDigest(document),
    summary: summarizeManagedPolicy(document),
  };
}

const makeTempDir = trackTempDirs();
afterEach(() => {
  installManagedAppSettings(null);
  installManagedApprovalCeiling(null);
});

async function harness() {
  const home = makeTempDir('station-project-managed-');
  const storage = new FileStorageAdapter(home);
  const app = createProjectRoutes(
    new ProjectService(storage) as any,
    storage as any,
    home,
    { listAgents: async () => [] },
  );
  await putProject(storage, {
    id: 'project-managed',
    slug: 'demo',
    name: 'Demo',
    workingDirectory: makeTempDir('station-project-managed-wd-'),
    defaultWorkspaceIsolation: 'shared',
    defaultApprovalMode: 'auto',
    defaultProviderId: 'project-provider',
    defaultModel: 'project-model',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  });
  const stored = () =>
    JSON.parse(
      readFileSync(join(home, 'projects', 'demo', 'project.json'), 'utf8'),
    ) as Record<string, unknown>;
  const send = (method: 'PUT' | 'POST', path: string, body: object) =>
    app.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { app, stored, send };
}

const LOCKS = {
  defaultWorkspaceIsolation: { value: 'worktree', locked: true },
  defaultApprovalMode: { value: 'ask', locked: true },
  defaultModel: { value: 'managed-model', locked: true },
};

describe('project writes under a managed lock', () => {
  test('a refused update carries the code, the key and the real support link', async () => {
    const { send, stored } = await harness();
    installManagedAppSettings(policy(LOCKS));
    const response = await send('PUT', '/demo', { defaultApprovalMode: 'ask' });
    expect(response.status).toBe(403);
    expect(await json(response)).toEqual({
      success: false,
      code: 'managed_setting_locked',
      key: 'defaultApprovalMode',
      error: DENIAL,
    });
    expect(stored().defaultApprovalMode).toBe('auto');
  });

  test('a refused create carries the same body', async () => {
    const { send } = await harness();
    installManagedAppSettings(policy(LOCKS));
    const response = await send('POST', '/', {
      name: 'Other',
      slug: 'other',
      defaultProviderId: 'someone-else',
    });
    expect(response.status).toBe(403);
    expect(await json(response)).toEqual({
      success: false,
      code: 'managed_setting_locked',
      key: 'defaultModel',
      error: DENIAL,
    });
  });

  test('a successful update answers without the hidden overrides, which stay stored', async () => {
    const { app, send, stored } = await harness();
    installManagedAppSettings(policy(LOCKS));
    const hidden = [
      'defaultWorkspaceIsolation',
      'defaultApprovalMode',
      'defaultProviderId',
      'defaultModel',
    ];
    const read = (await json(await app.request('/demo'))) as {
      data: Record<string, unknown>;
    };
    for (const field of hidden) expect(read.data).not.toHaveProperty(field);

    // What the project settings form sends after that read.
    const response = await send('PUT', '/demo', {
      description: 'edited under the lock',
      defaultWorkspaceIsolation: null,
      defaultApprovalMode: null,
      defaultApprovalModeSelection: null,
      defaultModelSelection: null,
      defaultModel: '',
      defaultProviderId: '',
    });
    expect(response.status).toBe(200);
    const body = (await json(response)) as { data: Record<string, unknown> };
    expect(body.data.description).toBe('edited under the lock');
    for (const field of hidden) expect(body.data).not.toHaveProperty(field);
    expect(stored()).toMatchObject({
      description: 'edited under the lock',
      defaultWorkspaceIsolation: 'shared',
      defaultApprovalMode: 'auto',
      defaultProviderId: 'project-provider',
      defaultModel: 'project-model',
    });
  });

  // #4517 + #4518: a lock on the approval default outranks the ceiling. The
  // lock takes no value at all, so the ceiling's "the broadest allowed is
  // Auto" would point at a value that is refused as well.
  test('a locked approval default refuses full access with the lock, not the ceiling, on create and update', async () => {
    const { send, stored } = await harness();
    const loaded = policy(
      { defaultApprovalMode: { value: 'ask', locked: true } },
      { maxApprovalMode: 'auto' },
    );
    installManagedAppSettings(loaded);
    installManagedApprovalCeiling(loaded);
    const locked = {
      success: false,
      code: 'managed_setting_locked',
      key: 'defaultApprovalMode',
      error: DENIAL,
    };

    const created = await send('POST', '/', {
      name: 'Other',
      slug: 'other',
      defaultApprovalMode: 'never',
    });
    expect(created.status).toBe(403);
    expect(await json(created)).toEqual(locked);

    const updated = await send('PUT', '/demo', {
      defaultApprovalMode: 'never',
    });
    expect(updated.status).toBe(403);
    expect(await json(updated)).toEqual(locked);
    expect(stored().defaultApprovalMode).toBe('auto');
  });
});
