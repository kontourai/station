import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import {
  KNOWLEDGE_ROOT_IDENTITY_HEADER,
  knowledgeRootIncarnationKey,
} from '@kontourai/station-shared/knowledge-root-identity';
import {
  type AuthenticatedE2ERequest,
  expect,
  test,
} from './helpers/authenticated-request';
import {
  type DeviceClassContext,
  openDeviceClassContext,
} from './helpers/device-class-context';
import { resolveE2EApiBase } from './helpers/e2e-target';

const API = resolveE2EApiBase();
const RECORD_ID = 'learning-source-proof-record';
const TITLE = 'Keep exact verification evidence';
function snapshot(directory: string) {
  const files: Record<string, string> = {};
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const file = join(path, name);
      if (statSync(file).isDirectory()) walk(file);
      else
        files[relative(directory, file)] =
          readFileSync(file).toString('base64');
    }
  };
  walk(directory);
  return files;
}
async function seed(
  request: AuthenticatedE2ERequest,
  storeRoot: string,
  title = TITLE,
): Promise<KnowledgeStoreRoot> {
  const response = await request.post(`${API}/api/knowledge/roots`, {
    data: {
      scope: { kind: 'personal' },
      adapterId: 'kit-default-store',
      storeRoot,
      displayName: 'Learning source proof',
    },
  });
  expect(response.ok()).toBeTruthy();
  const root = (await response.json()).data as KnowledgeStoreRoot;
  try {
    const record = await request.post(
      `${API}/api/knowledge/roots/${encodeURIComponent(root.id)}/records`,
      {
        data: {
          id: RECORD_ID,
          type: 'raw',
          title,
          category: 'feedback',
          body: 'Retain the exact check result when reporting a change. This source does not establish learning activation.',
          provenance: {
            agent: 'source-proof-owner',
            note: 'Created through the canonical record API in an isolated test store.',
          },
        },
      },
    );
    expect(record.ok()).toBeTruthy();
  } catch (error) {
    await remove(request, root);
    throw error;
  }
  return root;
}
async function remove(
  request: AuthenticatedE2ERequest,
  root: KnowledgeStoreRoot,
) {
  const response = await request.delete(
    `${API}/api/knowledge/roots/${encodeURIComponent(root.id)}`,
  );
  expect(response.ok()).toBeTruthy();
}

for (const viewport of [
  { label: 'desktop', width: 1280, height: 900 },
  { label: 'mobile', width: 390, height: 844 },
]) {
  test(`learning source inspection uses the real owner and local UI credential on ${viewport.label}`, async ({
    browser,
    baseURL,
    authenticatedRequest,
  }, testInfo) => {
    const directory = realpathSync(
      mkdtempSync(join(tmpdir(), 'station-learning-source-browser-')),
    );
    let root: KnowledgeStoreRoot | undefined;
    let local: DeviceClassContext | undefined;
    try {
      root = await seed(authenticatedRequest, directory);
      // The operator API credential is intentionally insufficient: only the
      // browser's actual home-possession mint may inspect personal source bytes.
      const denied = await authenticatedRequest.get(
        `${API}/api/knowledge/roots/${encodeURIComponent(root.id)}/records/${RECORD_ID}/source-observation`,
        {
          headers: {
            [KNOWLEDGE_ROOT_IDENTITY_HEADER]: encodeURIComponent(
              knowledgeRootIncarnationKey(root),
            ),
          },
        },
      );
      expect((await denied.json()).data).toEqual({ state: 'restricted' });
      local = await openDeviceClassContext(browser, baseURL!, 'host', {
        width: viewport.width,
        height: viewport.height,
      });
      const page = local.page;
      await page.goto(`${baseURL}/developer/memory`);
      const rootTab = page.getByRole('tab', {
        name: 'Learning source proof',
        exact: true,
      });
      if (await rootTab.count()) await rootTab.click();
      await page.getByTestId(`knowledge-recall-node-${RECORD_ID}`).click();
      const action = page.getByRole('button', {
        name: 'Inspect learning source',
        exact: true,
      });
      await expect(action).toBeVisible();
      const before = snapshot(directory);
      const mutations: string[] = [];
      page.on('request', (request) => {
        if (
          new URL(request.url()).pathname.startsWith('/api/knowledge') &&
          !['GET', 'OPTIONS'].includes(request.method())
        )
          mutations.push(request.method());
      });
      await action.click();
      const dialog = page.getByRole('dialog', {
        name: 'Learning source',
        exact: true,
      });
      await expect(
        dialog.getByRole('heading', { name: TITLE, exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByText('Learning status is unverified.', { exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByRole('button', {
          name: /approve|promote|activate|retire/i,
        }),
      ).toHaveCount(0);
      await expect(dialog).toHaveCSS('opacity', '1');
      if (viewport.label === 'mobile') {
        const box = await dialog.boundingBox();
        expect(box).toBeTruthy();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.width).toBeLessThanOrEqual(viewport.width);
        for (const name of ['Refresh source', 'Close']) {
          const bounds = await dialog
            .getByRole('button', { name, exact: true })
            .boundingBox();
          expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(44);
        }
      }
      await page.screenshot({
        path: testInfo.outputPath(`learning-source-${viewport.label}.png`),
        animations: 'disabled',
      });
      await dialog
        .getByRole('button', { name: 'Refresh source', exact: true })
        .click();
      await expect(
        dialog.getByRole('heading', { name: TITLE, exact: true }),
      ).toBeVisible();
      expect(mutations).toEqual([]);
      expect(snapshot(directory)).toEqual(before);
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    } finally {
      await local?.context.close();
      if (root) await remove(authenticatedRequest, root);
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('learning source inspection refuses a real replacement root with the same record ID', async ({
  browser,
  baseURL,
  authenticatedRequest,
}, testInfo) => {
  const first = realpathSync(
    mkdtempSync(join(tmpdir(), 'station-source-original-')),
  );
  const second = realpathSync(
    mkdtempSync(join(tmpdir(), 'station-source-replacement-')),
  );
  let root: KnowledgeStoreRoot | undefined;
  let local: DeviceClassContext | undefined;
  try {
    root = await seed(authenticatedRequest, first);
    local = await openDeviceClassContext(browser, baseURL!, 'host', {
      width: 1280,
      height: 900,
    });
    const page = local.page;
    await page.goto(`${baseURL}/developer/memory`);
    const tab = page.getByRole('tab', {
      name: 'Learning source proof',
      exact: true,
    });
    if (await tab.count()) await tab.click();
    await page.getByTestId(`knowledge-recall-node-${RECORD_ID}`).click();
    await page
      .getByRole('button', { name: 'Inspect learning source', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Learning source',
      exact: true,
    });
    await expect(
      dialog.getByRole('heading', { name: TITLE, exact: true }),
    ).toBeVisible();
    const originalId = root.id;
    const originalRegistration = knowledgeRootIncarnationKey(root);
    await remove(authenticatedRequest, root);
    root = undefined;
    root = await seed(
      authenticatedRequest,
      second,
      'Replacement source after explicit selection',
    );
    expect(root.id).toBe(originalId);
    // Real root notifications revoke the old selection before another refresh
    // can be sent. Preserve that cancellation instead of forcing a stale dialog.
    await expect(dialog).toHaveCount(0);
    const refused = await local.context.request.get(
      `${baseURL}/api/knowledge/roots/${encodeURIComponent(originalId)}/records/${RECORD_ID}/source-observation`,
      {
        headers: {
          [KNOWLEDGE_ROOT_IDENTITY_HEADER]:
            encodeURIComponent(originalRegistration),
        },
      },
    );
    expect(refused.status()).toBe(200);
    expect((await refused.json()).data).toEqual({ state: 'restricted' });
    await page.getByTestId(`knowledge-recall-node-${RECORD_ID}`).click();
    await page
      .getByRole('button', { name: 'Inspect learning source', exact: true })
      .click();
    await expect(
      dialog.getByRole('heading', {
        name: 'Replacement source after explicit selection',
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('learning-source-replaced.png'),
      animations: 'disabled',
    });
  } finally {
    await local?.context.close();
    if (root) await remove(authenticatedRequest, root);
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test('paired source inspection explains supported local access without exposing source', async ({
  browser,
  baseURL,
  authenticatedRequest,
}) => {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'station-source-paired-')),
  );
  let root: KnowledgeStoreRoot | undefined;
  let paired: DeviceClassContext | undefined;
  try {
    root = await seed(authenticatedRequest, directory);
    paired = await openDeviceClassContext(browser, baseURL!, 'paired', {
      width: 1280,
      height: 900,
    });
    const page = paired.page;
    await page.goto(`${baseURL}/developer/memory`);
    const tab = page.getByRole('tab', {
      name: 'Learning source proof',
      exact: true,
    });
    if (await tab.count()) await tab.click();
    await page.getByTestId(`knowledge-recall-node-${RECORD_ID}`).click();
    await page
      .getByRole('button', { name: 'Inspect learning source', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Learning source',
      exact: true,
    });
    await expect(
      dialog.getByText('Source inspection is restricted', { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText(/local launch link/)).toBeVisible();
    await expect(
      dialog.getByRole('heading', { name: TITLE, exact: true }),
    ).toHaveCount(0);
  } finally {
    await paired?.context.close();
    if (root) await remove(authenticatedRequest, root);
    rmSync(directory, { recursive: true, force: true });
  }
});
