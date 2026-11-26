import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { readE2EOperatorCredential } from './helpers/e2e-operator-credential';
import {
  buildExamplePlugin,
  installPluginWithConsent,
  previewPluginForInstall,
} from './helpers/install-plugin';
import {
  allocateLiveStation,
  startStation,
  stationRootForLiveHome,
  stopStation,
} from './helpers/live-station-task';
import { api, apiOk } from './live/helpers/station-instance.mjs';

const enterprise = 'enterprise-layout';
const sharedProviders = 'shared-providers';
const slug = 'enterprise-pane-lifecycle';
const projectPath = `/api/projects/${slug}`;
const knowledgePath = `${projectPath}/knowledge`;
const notesNamespace = 'enterprise-notes';
const settingsPath = `/api/plugins/${sharedProviders}/settings`;

async function installedPlugins(page: Page): Promise<string[]> {
  const { plugins } = await apiOk(page, 'GET', '/api/plugins');
  return plugins.map(({ name }: { name: string }) => name);
}

async function openPane(page: Page, ui: string, name: string) {
  const { data: catalog } = await apiOk(page, 'GET', `${projectPath}/panes`);
  const descriptors = catalog.descriptors.filter(
    (entry: { name: string; provenance: { pluginId?: string } }) =>
      entry.provenance.pluginId === enterprise && entry.name === name,
  );
  expect(descriptors).toHaveLength(1);
  const occurrences = catalog.instances.filter(
    (entry: { descriptorId: string }) =>
      entry.descriptorId === descriptors[0].id,
  );
  expect(occurrences).toHaveLength(1);
  const [occurrence] = occurrences;
  expect(occurrence.boundContext?.projectId).toBe(catalog.projectId);

  await page.goto(`${ui}/projects/${slug}`);
  await page.getByText('Open workspace', { exact: true }).click();
  await page.getByRole('button', { name: '+ Add pane', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Add workspace pane' })
    .getByRole('button', { name: `Open ${name}`, exact: true })
    .click();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname.startsWith(`/projects/${slug}/panes/`) &&
      decodeURIComponent(url.pathname.split('/').at(-1) ?? '') ===
        occurrence.instanceId,
  );
}

// Keep the provider transport real while making search independent of accounts,
// model availability, and relevance. Station writes and searches its own vectors.
function embeddingFixture() {
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/models') {
      response.end(JSON.stringify({ data: [{ id: 'fixture-embedding' }] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/embeddings') {
      try {
        let body = '';
        request.setEncoding('utf8');
        for await (const chunk of request) body += chunk;
        const payload = JSON.parse(body);
        if (
          payload.model !== 'fixture-embedding' ||
          !Array.isArray(payload.input) ||
          !payload.input.every((text: unknown) => typeof text === 'string')
        ) {
          throw new Error('Unexpected embedding request');
        }
        response.end(
          JSON.stringify({
            data: payload.input.map((text: string) => ({
              embedding: [1, text.length / 100],
            })),
          }),
        );
        return;
      } catch {
        response.writeHead(400).end('{"error":"Invalid embedding request"}');
        return;
      }
    }
    response.writeHead(404).end('{"error":"Unknown fixture route"}');
  });
}

async function uploadNote(
  page: Page,
  namespace: string,
  filename: string,
  content: string,
) {
  const { data } = await apiOk(
    page,
    'POST',
    `${knowledgePath}/ns/${namespace}/upload`,
    {
      filename,
      content,
      metadata: { title: filename },
    },
  );
  return data.id as string;
}

async function searchDocumentIds(page: Page, namespace?: string) {
  const path = `${knowledgePath + (namespace ? `/ns/${namespace}` : '')}/search`;
  const { data } = await apiOk(page, 'POST', path, {
    query: 'enterprise namespace evidence',
    topK: 20,
  });
  return new Set(
    data.map(({ metadata }: { metadata: { docId: string } }) => metadata.docId),
  );
}

test('installs Enterprise with its dependency and opens Dashboard and Notes from a clean Project', async ({
  browser,
}, testInfo) => {
  test.setTimeout(420_000);
  const live = await allocateLiveStation(
    'station-enterprise-pane-',
    'enterprise-pane',
  );
  const root = stationRootForLiveHome(live.home);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith('STATION_') && !['TMPDIR', 'TMP', 'TEMP'].includes(key),
    ),
  );
  const embeddings = embeddingFixture();
  const page = await browser.newPage();
  const enterpriseSource = resolve('examples', enterprise);
  const providerSource = resolve('examples', sharedProviders);
  let passed = false;
  try {
    const token = await startStation(live, true, {
      logFile: testInfo.outputPath('station.log'),
      environment: { ...environment, OTEL_SDK_DISABLED: 'true' },
    });
    const exchange = page.waitForResponse(
      (response) =>
        response.url().endsWith('/pairing/ui-bootstrap') &&
        response.request().method() === 'POST',
    );
    await page.addInitScript(() =>
      localStorage.setItem('station:onboarding-setup-dismissed', '1'),
    );
    await page.goto(`${live.ui}/#station-ui-bootstrap=${token}`);
    expect((await exchange).status()).toBe(200);
    expect((await api(page, 'GET', '/api/boot')).status).toBe(200);

    const installEnvironment = {
      ...process.env,
      PW_BASE_URL: live.ui,
      PW_API_BASE_URL: live.api,
      STATION_E2E_HOST_CREDENTIAL: readE2EOperatorCredential(live.home),
    };

    buildExamplePlugin(enterpriseSource);
    expect(await installedPlugins(page)).not.toContain(enterprise);
    expect(await installedPlugins(page)).not.toContain(sharedProviders);
    const preview = await previewPluginForInstall(
      live.api,
      enterpriseSource,
      installEnvironment,
    );
    expect(preview.permissions?.required).toEqual([
      'agents.invoke',
      'navigation.dock',
    ]);
    expect(preview.dependencies).toMatchObject([
      { id: sharedProviders, consent: { permissions: ['providers.register'] } },
    ]);
    expect(await installedPlugins(page)).not.toContain(sharedProviders);
    expect((await api(page, 'GET', settingsPath)).status).toBe(404);

    const projectDirectory = join(root, 'workspace');
    mkdirSync(projectDirectory);
    await apiOk(page, 'POST', '/api/projects', {
      name: 'Enterprise Pane Lifecycle',
      slug,
      workingDirectory: projectDirectory,
    });

    await new Promise<void>((resolveListen, reject) => {
      embeddings.once('error', reject);
      embeddings.listen(0, '127.0.0.1', resolveListen);
    });
    const address = embeddings.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing embedding fixture address');
    await apiOk(page, 'POST', '/api/providers', {
      type: 'openai-compat',
      name: 'Enterprise test embeddings',
      enabled: true,
      capabilities: ['embedding'],
      config: {
        baseUrl: `http://127.0.0.1:${address.port}`,
        model: 'fixture-embedding',
      },
    });
    await apiOk(page, 'POST', `${knowledgePath}/namespaces`, {
      id: 'notes',
      label: 'Existing Project Notes',
      behavior: 'rag',
    });
    const legacy = await uploadNote(
      page,
      'notes',
      'legacy.md',
      'Legacy registered note',
    );
    const prior = await uploadNote(
      page,
      notesNamespace,
      'prior.md',
      'Prior Enterprise note',
    );
    const unrelated = await uploadNote(
      page,
      'unrelated',
      'unrelated.md',
      'Unrelated note',
    );
    expect(await searchDocumentIds(page)).toEqual(new Set([legacy]));
    expect(await searchDocumentIds(page, 'unrelated')).toEqual(
      new Set([unrelated]),
    );

    expect(
      await installPluginWithConsent(live.api, enterpriseSource, {
        env: installEnvironment,
      }),
    ).toMatchObject({ success: true, plugin: { name: enterprise } });
    expect(await installedPlugins(page)).toEqual(
      expect.arrayContaining([enterprise, sharedProviders]),
    );
    expect((await apiOk(page, 'GET', settingsPath)).values).toMatchObject({
      authDomain: 'login.example.com',
      debug: false,
    });

    expect(
      (
        await apiOk(page, 'POST', `${projectPath}/layouts/from-plugin`, {
          plugin: enterprise,
        })
      ).data.slug,
    ).toBe('enterprise');
    const { data: namespaces } = await apiOk(
      page,
      'GET',
      `${knowledgePath}/namespaces`,
    );
    expect(namespaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: notesNamespace, behavior: 'rag' }),
        expect.objectContaining({
          id: 'notes',
          label: 'Existing Project Notes',
          behavior: 'rag',
        }),
      ]),
    );
    expect(await searchDocumentIds(page)).toEqual(new Set([legacy, prior]));
    const legacyContent = await apiOk(
      page,
      'GET',
      `${knowledgePath}/ns/notes/${legacy}/content`,
    );
    expect(legacyContent.data.content).toBe('Legacy registered note');

    await openPane(page, live.ui, 'Dashboard');
    await expect(
      page.getByRole('heading', { name: 'Quick Actions' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'My Accounts' }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('enterprise-dashboard.png'),
    });

    await openPane(page, live.ui, 'Notes');
    await page.getByRole('button', { name: 'prior.md', exact: true }).click();
    const editor = page.locator('#note-editor-textarea');
    await expect(editor).toHaveValue('Prior Enterprise note');
    await page.getByRole('button', { name: '+ New', exact: true }).click();
    await page.getByTitle('Frontmatter', { exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('Browser proof note');
    await editor.fill('Written by the Enterprise Notes pane');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Note saved', { exact: true })).toBeVisible();
    const saved = page.getByRole('button', {
      name: 'Browser proof note',
      exact: true,
    });
    await expect(saved).toBeVisible();
    const { data: filtered } = await apiOk(
      page,
      'GET',
      knowledgePath +
        '/ns/' +
        notesNamespace +
        '?metadata.title=Browser%20proof%20note',
    );
    expect(filtered).toHaveLength(1);
    const [created] = filtered;
    expect(created.namespace).toBe(notesNamespace);
    await expect(page.getByTitle(created.path, { exact: true })).toBeVisible();
    expect(await searchDocumentIds(page)).toEqual(
      new Set([legacy, prior, created.id]),
    );

    await page.reload();
    await saved.click();
    await expect(editor).toHaveValue('Written by the Enterprise Notes pane');
    await page.screenshot({
      path: testInfo.outputPath('enterprise-notes.png'),
    });

    await apiOk(page, 'DELETE', `/api/registry/plugins/${enterprise}`);
    expect(await installedPlugins(page)).not.toContain(enterprise);
    expect(await installedPlugins(page)).not.toContain(sharedProviders);
    expect((await api(page, 'GET', settingsPath)).status).toBe(404);
    expect(
      (await apiOk(page, 'GET', `${projectPath}/panes`)).data.descriptors,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provenance: expect.objectContaining({ pluginId: enterprise }),
        }),
      ]),
    );

    expect(
      await installPluginWithConsent(live.api, providerSource, {
        env: installEnvironment,
      }),
    ).toMatchObject({ success: true, plugin: { name: sharedProviders } });
    await apiOk(page, 'PUT', settingsPath, { settings: { debug: true } });
    expect((await apiOk(page, 'GET', settingsPath)).values.debug).toBe(true);
    expect(
      await installPluginWithConsent(live.api, enterpriseSource, {
        env: installEnvironment,
      }),
    ).toMatchObject({ success: true, plugin: { name: enterprise } });
    await apiOk(page, 'DELETE', `/api/registry/plugins/${enterprise}`);
    expect(await installedPlugins(page)).not.toContain(enterprise);
    expect((await apiOk(page, 'GET', settingsPath)).values.debug).toBe(true);
    await apiOk(page, 'DELETE', `/api/registry/plugins/${sharedProviders}`);
    expect(await installedPlugins(page)).not.toContain(sharedProviders);
    expect((await api(page, 'GET', settingsPath)).status).toBe(404);
    await apiOk(page, 'DELETE', projectPath);
    passed = true;
  } finally {
    await page.close();
    try {
      await stopStation(live, { environment });
    } finally {
      if (embeddings.listening) {
        await new Promise<void>((resolveClose, reject) => {
          embeddings.close((error) => (error ? reject(error) : resolveClose()));
        });
      }
    }
    if (passed) rmSync(root, { recursive: true, force: true });
  }
});
