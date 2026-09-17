import { expect, test } from '@playwright/test';

const credential = process.env.STATION_CONTAINER_HOST_CREDENTIAL;
const workspace = process.env.STATION_CONTAINER_WORKSPACE;
const expectPersisted = process.env.STATION_CONTAINER_EXPECT_PERSISTED === '1';

test.skip(
  !credential || !workspace,
  'container self-host coverage is invoked by scripts/container-smoke.sh',
);

test('container serves one authenticated origin with writable Git workspace and persistent state', async ({
  browser,
  baseURL,
}) => {
  // This exercises a freshly started container and its mounted workspace on
  // shared-host storage. Keep a finite budget while avoiding the unit-sized
  // default that has expired during otherwise healthy host I/O contention.
  test.setTimeout(60_000);
  if (!baseURL || !credential || !workspace) {
    throw new Error('container smoke environment is incomplete');
  }
  const anonymous = await browser.newContext();
  const refused = await anonymous.request.post(`${baseURL}/api/projects`, {
    data: {
      name: 'Must not exist',
      slug: 'unauthorized-import',
      workingDirectory: workspace,
    },
  });
  expect([401, 403]).toContain(refused.status());
  await anonymous.close();

  const context = await browser.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${credential}` },
  });
  const page = await context.newPage();
  await page.goto(baseURL);

  const result = await page.evaluate(
    async ({ expectPersisted, workspace }) => {
      let projectStatus: number | null = null;
      let createStatus: number | null = null;
      let duplicateStatus: number | null = null;
      let createdProjectId: string | null = null;
      if (!expectPersisted) {
        const project = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Container self-host',
            slug: 'container-self-host',
            workingDirectory: workspace,
          }),
        });
        projectStatus = project.status;
        if (!project.ok) {
          throw new Error(`project creation failed: ${project.status}`);
        }
        createdProjectId = (await project.json()).data.id;
        const duplicate = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: 'Replacement must not win',
            slug: 'container-self-host',
            workingDirectory: '/different-workspace',
          }),
        });
        duplicateStatus = duplicate.status;
        const created = await fetch('/api/coding/files/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            path: workspace,
            target: 'container-created.txt',
            type: 'file',
          }),
        });
        createStatus = created.status;
        if (!created.ok)
          throw new Error(`workspace file creation failed: ${created.status}`);
      }
      const storedProject = await fetch(
        '/api/projects/container-self-host',
      ).then(async (response) => ({
        status: response.status,
        body: await response.json(),
      }));
      const content = await fetch(
        `/api/coding/files/content?path=${encodeURIComponent(workspace)}&file=container-sentinel.txt`,
      );
      const createdFile = await fetch(
        `/api/coding/files/content?path=${encodeURIComponent(workspace)}&file=container-created.txt`,
      );
      const changes = await fetch(
        `/api/coding/files/content?path=${encodeURIComponent(workspace)}&file=changes.txt`,
      );
      const gitStatus = await fetch(
        `/api/coding/git/status?path=${encodeURIComponent(workspace)}`,
      );
      return {
        createStatus,
        createdProjectId,
        duplicateStatus,
        changes: { status: changes.status, body: await changes.json() },
        createdFile: {
          status: createdFile.status,
          body: await createdFile.json(),
        },
        gitStatus: { status: gitStatus.status, body: await gitStatus.json() },
        projectStatus,
        storedProject,
        status: content.status,
        body: await content.json(),
      };
    },
    { expectPersisted, workspace },
  );

  expect(result.projectStatus).toBe(expectPersisted ? null : 201);
  expect(result.createStatus).toBe(expectPersisted ? null : 200);
  expect(result.duplicateStatus).toBe(expectPersisted ? null : 409);
  if (!expectPersisted) {
    expect(result.createdProjectId).toBeTruthy();
    expect(result.storedProject.body.data.id).toBe(result.createdProjectId);
  }
  expect(result.changes).toEqual({
    status: 200,
    body: {
      success: true,
      data: { path: 'changes.txt', content: 'working\n' },
    },
  });
  expect(result.createdFile).toEqual({
    status: 200,
    body: {
      success: true,
      data: { path: 'container-created.txt', content: '' },
    },
  });
  expect(result.gitStatus).toMatchObject({
    status: 200,
    body: {
      success: true,
      data: {
        isRepo: true,
        repoRoot: workspace,
        branch: 'main',
        lastCommit: {
          author: 'Station smoke',
          message: 'Seed container workspace',
        },
      },
    },
  });
  expect(result.gitStatus.body.data.lastCommit.sha).toMatch(/^[a-f0-9]{8}$/);
  expect(result.storedProject).toEqual({
    status: 200,
    body: {
      success: true,
      data: expect.objectContaining({
        slug: 'container-self-host',
        workingDirectory: workspace,
      }),
    },
  });
  expect(result.status).toBe(200);
  expect(result.body).toEqual({
    success: true,
    data: {
      path: 'container-sentinel.txt',
      content: 'station container sentinel\n',
    },
  });
  await context.close();
});
