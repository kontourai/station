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
  const routes = createDelegationGrantRoutes(
    new DelegationGrantStore(home, logger),
    preview,
    () => true,
  );
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
    operator: withOperatorPrincipal(routes),
    internal,
    enable: () => previews.setEnabled('delegation-grants', true),
  };
}

function createGrant(app: Hono, input = grant) {
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
