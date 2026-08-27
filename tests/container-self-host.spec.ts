import { expect, test } from '@playwright/test';

const credential = process.env.STATION_CONTAINER_HOST_CREDENTIAL;
const workspace = process.env.STATION_CONTAINER_WORKSPACE;
const expectPersisted = process.env.STATION_CONTAINER_EXPECT_PERSISTED === '1';

test.skip(
  !credential || !workspace,
  'container self-host coverage is invoked by scripts/container-smoke.sh',
);

test('container serves one authenticated origin and reads its mounted workspace', async ({
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
  const context = await browser.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${credential}` },
  });
  const page = await context.newPage();
  await page.goto(baseURL);

  const result = await page.evaluate(
    async ({ expectPersisted, workspace }) => {
      let projectStatus: number | null = null;
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
      return {
        projectStatus,
        storedProject,
        status: content.status,
        body: await content.json(),
      };
    },
    { expectPersisted, workspace },
  );

  expect(result.projectStatus).toBe(expectPersisted ? null : 201);
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
