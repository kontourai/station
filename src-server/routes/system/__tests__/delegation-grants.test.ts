import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { withOperatorPrincipal } from '../../../__test-utils__/operator-principal.js';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { DelegationGrantStore } from '../../../security/confinement/delegation-grants.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { FeaturePreviewRegistry } from '../../../services/feature-previews/feature-preview-registry.js';
import { createLogger } from '../../../utils/logger.js';
import { createDelegationGrantRoutes } from '../delegation-grants.js';

const makeTempDir = trackTempDirs();
const logger = createLogger({ name: 'delegation-grant-test', level: 'error' });
const grant = {
  access: 'full-access',
  agents: ['codex'],
  models: ['coding-model'],
  projects: ['test-project'],
};

function mount() {
  const home = makeTempDir('station-delegation-grants-');
  const previews = new FeaturePreviewRegistry(home, logger);
  const preview = previews.bind({
    id: 'delegation-grants',
    label: 'Delegation grants',
    description: 'Manage access for named delegations.',
  });
  const store = new DelegationGrantStore(home, logger);
  const routes = createDelegationGrantRoutes(store, preview, () => true);
  const internal = new Hono();
  internal.use('*', async (c, next) => {
    setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
      kind: 'internal',
      credential: 'station-internal',
      authority: 'operator-credential',
      source: 'bearer',
    });
    await next();
  });
  internal.route('/', routes);
  return {
    home,
    store,
    operator: withOperatorPrincipal(routes),
    internal,
    enable: () => previews.setEnabled('delegation-grants', true),
  };
}

function createGrant(app: Hono, input: object = grant) {
  return app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

test('an operator can create and revoke a grant only with the preview enabled', async () => {
  const { operator, enable } = mount();
  expect((await createGrant(operator)).status).toBe(404);
  await enable();
  const empty = await operator.request('/');
  expect(await empty.json()).toMatchObject({ data: [] });

  const created = await createGrant(operator);
  expect(created.status).toBe(201);
  const { data } = await readJson<{ data: { id: string } }>(created);
  expect(data).toMatchObject({
    ...grant,
    ownWorktree: true,
    createdBy: 'operator',
    expiry: { kind: 'parent-session' },
  });
  const listed = await operator.request('/');
  expect(await listed.json()).toMatchObject({ data: [data] });
  expect(
    (await operator.request(`/${data.id}`, { method: 'DELETE' })).status,
  ).toBe(200);
  const afterRevoke = await operator.request('/');
  expect(await afterRevoke.json()).toMatchObject({ data: [] });
});

test('an internal agent cannot create grants by presenting the internal operator credential', async () => {
  const { internal, operator, enable } = mount();
  await enable();
  expect((await createGrant(internal)).status).toBe(403);
  const listed = await operator.request('/');
  expect(await listed.json()).toMatchObject({ data: [] });
});

test('a corrupt grants file withdraws standing grants and reports the outage to the operator', async () => {
  const { home, store, operator, enable } = mount();
  await enable();
  expect((await createGrant(operator)).status).toBe(201);
  expect(store.list()).toHaveLength(1);

  writeFileSync(join(home, 'config', 'delegation-grants.json'), '{');
  expect(store.list()).toEqual([]);
  const response = await operator.request('/');
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: expect.stringContaining('Standing grants are disabled'),
  });
});

test.each([
  'objects',
  'objects/info',
  'objects/aa',
  'OBJECTS/INFO/alternates',
  'worktrees',
  'worktrees/another',
  '../config',
  '/tmp',
])(
  'the operator cannot grant writes to a protected Git path: %s',
  async (path) => {
    const { operator, enable } = mount();
    await enable();
    const response = await createGrant(operator, {
      ...grant,
      extraGitWritePaths: { 'test-project': [path] },
    });
    expect(response.status).toBe(400);
    const listed = await operator.request('/');
    expect(await listed.json()).toMatchObject({ data: [] });
  },
);

test('requires separate operator confirmation for writes to shared Git metadata', async () => {
  const { operator, enable } = mount();
  await enable();
  const request = {
    ...grant,
    extraGitWritePaths: {
      'test-project': [
        'hooks',
        'config',
        'refs/remotes',
        'refs/heads/topic',
        'packed-refs',
      ],
    },
  };
  const refused = await createGrant(operator, request);
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({
    error: expect.stringContaining('separate operator confirmation'),
  });
  expect(
    (
      await createGrant(operator, {
        ...request,
        highRiskGitWritesConfirmed: true,
      })
    ).status,
  ).toBe(201);
  expect(await (await operator.request('/')).json()).toMatchObject({
    data: [{ highRiskGitWrites: true }],
  });
});

test('ignores hand-added and modified grants while listing authenticated grants', async () => {
  const { home, store, operator, enable } = mount();
  await enable();
  const valid = await createGrant(operator);
  expect(valid.status).toBe(201);
  const { data } = await readJson<{ data: { id: string } }>(valid);
  const path = join(home, 'config', 'delegation-grants.json');
  const [signed] = JSON.parse(readFileSync(path, 'utf8'));
  const unsigned = {
    ...signed.grant,
    id: '512e80a5-884f-4983-910c-e7f93030ff7e',
  };
  const modified = {
    ...signed,
    grant: { ...signed.grant, models: ['forged-model'] },
  };
  writeFileSync(path, JSON.stringify([signed, unsigned, modified]));

  expect(store.list().map(({ id }) => id)).toEqual([data.id]);
  const list = await operator.request('/');
  expect(await list.json()).toMatchObject({
    ignoredEntries: 2,
    data: [{ id: data.id, models: grant.models }],
  });
});
