import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { RepositoryProviderCatalog } from '../../../services/projects/repository-provider-catalog.js';
import { createRepositoryAcquisitionRoutes } from '../repository-acquisition-routes.js';

const temp = trackTempDirs();
const repository = {
  id: 1,
  full_name: 'team/private',
  html_url: 'https://github.com/team/private',
  clone_url: 'https://github.com/team/private.git',
  ssh_url: 'git@github.com:team/private.git',
  default_branch: 'main',
  private: true,
};
test('host repository discovery refuses non-operator admission before any provider call', async () => {
  const transport = vi.fn();
  const app = new Hono().route(
    '/',
    createRepositoryAcquisitionRoutes(
      temp('catalog-route-'),
      () => false,
      new RepositoryProviderCatalog(transport),
    ),
  );
  expect((await app.request('/repository-providers/github')).status).toBe(403);
  expect(transport).not.toHaveBeenCalled();
});
test('private repository bytes are withheld if authority ends before response consumption', async () => {
  let allowed = true;
  const transport = vi
    .fn()
    .mockResolvedValueOnce({ stdout: '{"id":42,"login":"alice"}' })
    .mockResolvedValueOnce({ stdout: JSON.stringify([repository]) })
    .mockResolvedValueOnce({ stdout: '{"id":42,"login":"alice"}' });
  const app = new Hono().route(
    '/',
    createRepositoryAcquisitionRoutes(
      temp('catalog-release-'),
      () => allowed,
      new RepositoryProviderCatalog(transport),
    ),
  );
  const response = await app.request('/repository-providers/github');
  expect(response.status).toBe(200);
  allowed = false;
  await expect(response.text()).rejects.toThrow('authorization ended');
});
test('unsupported providers and pages refuse while command failures give a fixed recovery action', async () => {
  const transport = vi
    .fn()
    .mockRejectedValue(new Error('private command error'));
  const app = new Hono().route(
    '/',
    createRepositoryAcquisitionRoutes(
      temp('catalog-errors-'),
      () => true,
      new RepositoryProviderCatalog(transport),
    ),
  );
  expect((await app.request('/repository-providers/other')).status).toBe(400);
  expect(
    (await app.request('/repository-providers/github?page=0')).status,
  ).toBe(400);
  expect(transport).not.toHaveBeenCalled();
  const response = await app.request('/repository-providers/gitlab');
  expect(response.status).toBe(503);
  const text = await response.text();
  expect(text).toContain('glab auth login');
  expect(text).not.toContain('private command error');
});
