import { expect, type Page, test } from '@playwright/test';

/**
 * Coverage for the Computers section's "Add a computer" -> SSH branch (D7,
 * audit CI-R1/CI-R14/CI-R19): `src-ui/src/views/connections-hub/AddMachineModal.tsx`
 * (the goal chooser) and `SshComputerCreatorDialog.tsx` (the SSH creator).
 *
 * The load-bearing claims under test:
 *  - the chooser offers all three goals (control / station / delegate);
 *  - the SSH creator's "Save computer" stays disabled until a real probe
 *    (`POST /api/environments/ssh/probe`) reports `reachable: true`, and both
 *    the server's `summary` and `action` render together in a `role="alert"`
 *    on a failing probe;
 *  - the pre-test disclosure copy is present before any probe has run;
 *  - a successful probe both enables Save and, after saving, the new
 *    computer appears in the Computers list.
 *
 * Every route is intercepted with `page.route` (house style from
 * `tests/ssh-environments-ui.spec.ts`), so this spec never depends on live
 * backend or SSH state.
 */

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

interface SshEnvironmentProfile {
  schemaVersion: 1;
  id: string;
  name: string;
  hostAlias: string;
  remoteProjectPath: string;
  remotePort: number;
  environmentId: string | null;
  hostIdentity: string | null;
  verifiedProjectPath: string | null;
  workerProtocolVersion: number | null;
  createdAt: string;
  updatedAt: string;
  lastConnectedAt: string | null;
}

interface SshEnvironment {
  profile: SshEnvironmentProfile;
  state: { phase: string } & Record<string, unknown>;
}

const PROBE_FAILURE = {
  evidenceVersion: 1,
  level: 'discovered',
  freshness: 'fresh',
  observedAt: '2026-08-20T00:00:00.000Z',
  reachable: false,
  summary: 'Station could not reach box-b: connection refused on port 22.',
  action:
    'Confirm box-b is powered on and reachable on your network, then try again.',
};

const PROBE_SUCCESS = {
  evidenceVersion: 1,
  level: 'discovered',
  freshness: 'fresh',
  observedAt: '2026-08-20T00:00:05.000Z',
  reachable: true,
  summary:
    'Station reached box-b over SSH and verified the remote project folder.',
  resolved: {
    hostname: 'box-b.tailnet',
    user: 'brian',
    port: 22,
    identityAgent: 'default',
  },
};

async function seedRoutes(page: Page) {
  const state: { environments: SshEnvironment[]; probeCalls: number } = {
    environments: [],
    probeCalls: 0,
  };

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    if (path === '/api/auth/status') {
      await route.fulfill(json({ authenticated: true, user: null }));
      return;
    }
    if (path === '/api/branding') {
      await route.fulfill(json({ success: true, data: {} }));
      return;
    }
    if (path === '/config/app') {
      await route.fulfill(
        json({
          success: true,
          data: { defaultModel: '', region: 'us-east-1' },
        }),
      );
      return;
    }
    if (path === '/api/projects') {
      await route.fulfill(json({ success: true, data: [] }));
      return;
    }
    if (path === '/api/agents') {
      await route.fulfill(json({ success: true, data: [] }));
      return;
    }
    if (path === '/api/models') {
      await route.fulfill(json({ success: true, data: [] }));
      return;
    }
    if (path === '/api/connections') {
      await route.fulfill(json({ success: true, data: [] }));
      return;
    }
    if (path === '/api/connections/models') {
      await route.fulfill(json({ success: true, data: [] }));
      return;
    }
    if (path === '/api/connections/agents') {
      await route.fulfill(json({ success: true, data: [] }));
      return;
    }
    if (path === '/api/knowledge/status') {
      await route.fulfill(
        json({
          success: true,
          data: {
            vectorDb: null,
            embedding: null,
            stats: { totalDocuments: 0, totalChunks: 0, projectCount: 0 },
          },
        }),
      );
      return;
    }
    if (path === '/api/system/identity') {
      await route.fulfill(
        json({
          environmentId: 'e2e-computers-ssh',
          instanceId: 'e2e-computers-ssh-instance',
          bootId: 'e2e-computers-ssh-boot',
          sha: '3333333333333333333333333333333333333333',
        }),
      );
      return;
    }
    if (path === '/api/system/status') {
      await route.fulfill(
        json({
          ready: true,
          acp: { connected: false, connections: [] },
          clis: {},
          prerequisites: [],
          providers: {
            configuredChatReady: true,
            configured: [],
            detected: { ollama: false, bedrock: false },
          },
          capabilities: { chat: { ready: true, source: null } },
        }),
      );
      return;
    }
    if (path === '/api/system/capabilities') {
      await route.fulfill(
        json({
          runtime: 'voltagent',
          voice: { stt: [], tts: [] },
          context: { providers: [] },
          scheduler: true,
        }),
      );
      return;
    }
    if (path === '/api/environments/ssh/hosts') {
      await route.fulfill(
        json({
          success: true,
          data: {
            hosts: [
              {
                alias: 'box-b',
                hostname: 'box-b.tailnet',
                user: 'brian',
                port: 22,
                identityAgent: 'default',
                proxyJump: null,
                strictHostKeyChecking: 'ask',
              },
            ],
            unavailableAliases: [],
          },
        }),
      );
      return;
    }
    if (path === '/api/environments/ssh/probe' && method === 'POST') {
      state.probeCalls += 1;
      const evidence = state.probeCalls === 1 ? PROBE_FAILURE : PROBE_SUCCESS;
      await route.fulfill(json({ success: true, data: evidence }));
      return;
    }
    if (path === '/api/environments/ssh' || path === '/api/environments/ssh/') {
      if (method === 'POST') {
        const body = request.postDataJSON() as {
          name?: string;
          hostAlias: string;
          remoteProjectPath: string;
          remotePort?: number;
        };
        const created: SshEnvironment = {
          profile: {
            schemaVersion: 1,
            id: 'ssh-box-b',
            name: body.name ?? body.hostAlias,
            hostAlias: body.hostAlias,
            remoteProjectPath: body.remoteProjectPath,
            remotePort: body.remotePort ?? 3141,
            environmentId: null,
            hostIdentity: null,
            verifiedProjectPath: null,
            workerProtocolVersion: null,
            createdAt: '2026-08-20T00:00:10.000Z',
            updatedAt: '2026-08-20T00:00:10.000Z',
            lastConnectedAt: null,
          },
          state: { phase: 'idle' },
        };
        state.environments = [created];
        await route.fulfill(json({ success: true, data: created }, 201));
        return;
      }
      await route.fulfill(json({ success: true, data: state.environments }));
      return;
    }

    await route.fulfill(json({ success: true, data: [] }));
  });

  await page.route('**/integrations**', async (route) => {
    await route.fulfill(json({ success: true, data: [] }));
  });
  await page.route('**/acp/**', async (route) => {
    await route.fulfill(json({ success: true, data: [] }));
  });
}

test.describe('Add a computer — SSH branch', () => {
  test.beforeEach(async ({ page }) => {
    await seedRoutes(page);
  });

  test('the chooser offers all three goals; the SSH creator gates Save on a real probe and reflects the new computer', async ({
    page,
  }) => {
    await page.goto('/connections/computers');
    await expect(
      page.getByRole('heading', { name: 'Computers', level: 1, exact: true }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Add computer' }).click();
    const chooser = page.getByRole('dialog', {
      name: 'What do you want to do?',
    });
    await expect(chooser).toBeVisible();
    await expect(
      chooser.getByRole('button', {
        name: /Control this Station from another device/,
      }),
    ).toBeVisible();
    await expect(
      chooser.getByRole('button', { name: /Reach another Station/ }),
    ).toBeVisible();
    const delegateOption = chooser.getByRole('button', {
      name: /Run work on another computer over SSH/,
    });
    await expect(delegateOption).toBeVisible();
    await delegateOption.click();

    const dialog = page.getByRole('dialog', {
      name: 'Run work on another computer over SSH',
    });
    await expect(dialog).toBeVisible();

    const saveButton = dialog.getByRole('button', { name: 'Save computer' });
    const testButton = dialog.getByRole('button', { name: 'Test connection' });

    // Before any probe: Save is disabled and the dialog says why.
    await expect(saveButton).toBeDisabled();
    await expect(
      dialog.getByText(
        'Test the connection before saving — Station only saves a computer it has reached.',
      ),
    ).toBeVisible();

    await dialog.getByPlaceholder('box-b, or 192.168.1.20').fill('box-b');
    await testButton.click();

    // A failing probe renders BOTH the server's summary and its action, in
    // an alert, and Save stays disabled.
    const failureAlert = dialog.getByRole('alert');
    await expect(failureAlert).toContainText(PROBE_FAILURE.summary);
    await expect(failureAlert).toContainText(PROBE_FAILURE.action);
    await expect(saveButton).toBeDisabled();

    // A second probe that actually reaches the host enables Save — proving
    // the gate tracks a real observation, not a permanently-disabled button.
    await testButton.click();
    const successStatus = dialog
      .getByRole('status')
      .filter({ hasText: 'Reached' });
    await expect(successStatus).toContainText(PROBE_SUCCESS.summary);
    await expect(saveButton).toBeEnabled();

    await saveButton.click();
    await expect(dialog).toBeHidden();

    const row = page
      .locator('.connections-computers__row')
      .filter({ hasText: 'box-b' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Not connected');
  });
});

test.describe('Add a computer — SSH branch at 390x844', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test.beforeEach(async ({ page }) => {
    await seedRoutes(page);
  });

  test('the SSH creator dialog stays within the viewport and still gates Save on a real probe', async ({
    page,
  }) => {
    await page.goto('/connections/computers');
    await page.getByRole('button', { name: 'Add computer' }).click();
    await page
      .getByRole('dialog', { name: 'What do you want to do?' })
      .getByRole('button', { name: /Run work on another computer over SSH/ })
      .click();

    const dialog = page.getByRole('dialog', {
      name: 'Run work on another computer over SSH',
    });
    await expect(dialog).toBeVisible();
    const saveButton = dialog.getByRole('button', { name: 'Save computer' });
    await expect(saveButton).toBeDisabled();

    await dialog.getByPlaceholder('box-b, or 192.168.1.20').fill('box-b');
    await dialog.getByRole('button', { name: 'Test connection' }).click();

    const failureAlert = dialog.getByRole('alert');
    await expect(failureAlert).toContainText(PROBE_FAILURE.summary);
    await expect(failureAlert).toContainText(PROBE_FAILURE.action);
    await expect(saveButton).toBeDisabled();

    const noHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(noHorizontalScroll).toBe(true);
  });
});
