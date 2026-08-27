import { expect, type Page, test } from '@playwright/test';
import { MIN_TOUCH_TARGET_PX } from './helpers/touch-target';
import { installVisualViewportFixture } from './helpers/visual-viewport';

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

type Environment = {
  profile: {
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
  };
  state: Record<string, unknown> & { phase: string };
};

function environment(
  state: Environment['state'] = { phase: 'idle' },
): Environment {
  return {
    profile: {
      schemaVersion: 1,
      id: 'remote-1',
      name: 'Brian media',
      hostAlias: 'brian-media',
      remoteProjectPath: '~/dev/github/kontourai/station',
      remotePort: 3141,
      environmentId: 'environment-1',
      hostIdentity: 'ssh:host-1',
      verifiedProjectPath: '~/dev/github/kontourai/station',
      workerProtocolVersion: 1,
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
      lastConnectedAt: '2026-07-18T00:00:00.000Z',
    },
    state,
  };
}

async function seedRoutes(page: Page, initial: Environment[] = []) {
  const state = { environments: structuredClone(initial) };

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
          data: { defaultModel: 'codex-mini', region: 'us-east-1' },
        }),
      );
      return;
    }
    if (path === '/api/projects') {
      await route.fulfill(json({ success: true, data: [] }));
      return;
    }
    if (path === '/api/models') {
      await route.fulfill(json({ success: true, data: [] }));
      return;
    }
    if (path === '/api/agents') {
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
    if (path === '/api/connections') {
      await route.fulfill(
        json({
          success: true,
          data: [
            {
              id: 'ollama-local',
              kind: 'model',
              type: 'ollama',
              name: 'Local Ollama',
              enabled: true,
              status: 'ready',
              capabilities: ['llm'],
              config: {},
              prerequisites: [],
              lastCheckedAt: null,
            },
            {
              id: 'codex-runtime',
              kind: 'agent',
              type: 'codex',
              name: 'Codex Runtime',
              description: 'Connected runtime',
              enabled: true,
              status: 'ready',
              capabilities: ['agent-runtime'],
              config: {},
              prerequisites: [],
              runtimeCatalog: {
                source: 'static',
                reason: 'Mock runtime catalog',
                models: [{ id: 'codex-mini', name: 'Codex Mini' }],
                builtInModels: [],
              },
            },
          ],
        }),
      );
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
    if (path === '/api/integrations' || path === '/integrations') {
      await route.fulfill(json({ success: true, data: [] }));
      return;
    }
    if (path === '/api/acp/connections' || path === '/acp/connections') {
      await route.fulfill(json({ success: true, data: [] }));
      return;
    }
    if (path === '/api/acp/registry' || path === '/acp/registry') {
      await route.fulfill(json({ success: true, data: [] }));
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
    if (path === '/api/system/identity') {
      await route.fulfill(
        json({
          environmentId: 'test-environment',
          instanceId: 's432-browser',
          bootId: 'boot-s432-browser',
          sha: 'b3a4ce6b45bb67bfe37613eb129af31e0a13e5e2',
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
          providers: {
            configuredChatReady: true,
            configured: [
              {
                id: 'ollama-local',
                type: 'ollama',
                enabled: true,
                capabilities: ['llm'],
              },
            ],
            detected: { ollama: true, bedrock: false },
          },
          capabilities: {
            chat: { ready: true, source: 'ollama-local' },
          },
          recommendation: {
            code: 'configured-chat-ready',
            type: 'providers',
            actionLabel: 'Manage connections',
            title: 'Connections ready',
            detail: 'Mocked connection inventory',
          },
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
                alias: 'brian-media',
                hostname: 'brian-media.tailnet',
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
    // The SSH creator gates Save on a real probe
    // (`views/connections-hub/SshComputerCreatorDialog.tsx:67,90`); without
    // this the catch-all's `[]` gave `evidence.reachable === undefined` and
    // Save stayed disabled forever. Shape from
    // `tests/connections-computers-ssh.spec.ts`.
    if (path === '/api/environments/ssh/probe' && method === 'POST') {
      await route.fulfill(
        json({
          success: true,
          data: {
            evidenceVersion: 1,
            level: 'discovered',
            freshness: 'fresh',
            observedAt: '2026-08-20T00:00:05.000Z',
            reachable: true,
            summary:
              'Station reached brian-media over SSH and verified the remote project folder.',
            resolved: {
              hostname: 'brian-media.tailnet',
              user: 'brian',
              port: 22,
              identityAgent: 'default',
            },
          },
        }),
      );
      return;
    }
    // Otherwise `usePeerCredentialsQuery` (`ComputersSection.tsx:145`) reaches
    // the live instance and can append an outbound-peer row this fixture never
    // seeded.
    if (path === '/api/environments/peers') {
      await route.fulfill(json({ success: true, data: [] }));
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
        const created = environment();
        created.profile.name = body.name ?? body.hostAlias;
        created.profile.hostAlias = body.hostAlias;
        created.profile.remoteProjectPath = body.remoteProjectPath;
        created.profile.remotePort = body.remotePort ?? 3141;
        created.profile.environmentId = null;
        created.profile.lastConnectedAt = null;
        state.environments = [created];
        await route.fulfill(json({ success: true, data: created }, 201));
        return;
      }
      await route.fulfill(json({ success: true, data: state.environments }));
      return;
    }

    const actionMatch = path.match(
      /^\/api\/environments\/ssh\/([^/]+)\/(connect|disconnect)$/,
    );
    if (actionMatch && method === 'POST') {
      const target = state.environments.find(
        (item) => item.profile.id === decodeURIComponent(actionMatch[1]),
      );
      if (!target) {
        await route.fulfill(json({ success: false, error: 'Not found' }, 404));
        return;
      }
      target.state =
        actionMatch[2] === 'connect'
          ? {
              phase: 'connected',
              localUrl: 'http://127.0.0.1:43141',
              instanceId: 'remote-instance',
              sha: 'abcdef0',
              bootId: 'boot-1',
              connectedAt: '2026-07-18T00:00:00.000Z',
            }
          : { phase: 'disconnected', reason: 'stopped' };
      if (actionMatch[2] === 'connect') {
        target.profile.lastConnectedAt = '2026-07-18T00:00:00.000Z';
      }
      await route.fulfill(json({ success: true, data: target }));
      return;
    }

    await route.fulfill(json({ success: true, data: [] }));
  });

  await page.route('**/config/app', async (route) => {
    await route.fulfill(
      json({
        success: true,
        data: { defaultModel: 'codex-mini', region: 'us-east-1' },
      }),
    );
  });

  await page.route('**/integrations**', async (route) => {
    await route.fulfill(json({ success: true, data: [] }));
  });

  await page.route('**/acp/**', async (route) => {
    await route.fulfill(json({ success: true, data: [] }));
  });
}

test.describe('SSH execution environments', () => {
  /**
   * The SSH creator's own two claims: it says where the key comes from and
   * never asks for one, and it stays usable above a phone keyboard.
   *
   * Everything else this test used to walk — the chooser's three goals, Save
   * gating on a real probe, the failing probe's named cause and next step, the
   * saved row reading "Not connected" — is owned by
   * `tests/connections-computers-ssh.spec.ts:261` and its 390 sibling at `:345`,
   * so it is not repeated here.
   */
  test('the SSH creator says where the key comes from and stays usable above a mobile keyboard', async ({
    page,
  }) => {
    await seedRoutes(page);
    await installVisualViewportFixture(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    // `/connections` is a resolver, not a page (`views/ConnectionsHub.tsx:14-21`)
    // and `?section=` means nothing to it; Computers is the section that owns
    // the `Add computer` action (`connection-sections.ts:38-45`).
    await page.goto('/connections/computers');

    const addComputer = page
      .locator('.page__actions')
      .getByRole('button', { name: 'Add computer', exact: true });
    await expect(addComputer).toBeVisible();
    await addComputer.click();
    const machineGoalDialog = page.getByRole('dialog', {
      name: 'What do you want to do?',
    });
    await expect(machineGoalDialog).toBeVisible();
    await machineGoalDialog
      .getByRole('button', { name: /Run work on another computer over SSH/ })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Run work on another computer over SSH',
    });
    await expect(dialog).toBeVisible();
    // The positive claim: the key is the SSH config's, and Station never asks
    // for one (`SshComputerCreatorDialog.tsx:179-183`).
    await expect(
      dialog.getByText(/The user, port and key come from that SSH config/),
    ).toBeVisible();
    await expect(dialog.getByLabel(/private key/i)).toHaveCount(0);

    // Escape returns focus to the frame's trigger, across the
    // chooser-replaced-by-creator swap.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // Every dialog, not just the creator: the chooser is still mounted behind
    // it, and while ANY of them is open the frame's background is inert — which
    // hides the trigger from a role query as well as from the user.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Focus is deliberately NOT asserted to land back on the trigger here. The
    // creator replaces the chooser, so the surface that closes last captured a
    // chooser button as its return target and that button is gone — the
    // documented fallback then walks to the nearest surviving ancestor rather
    // than to the original trigger. Return-focus for a single dialog opened
    // from this very action is asserted in `tests/connections-crud.spec.ts`,
    // and the fallback walk itself in `tests/dialog-return-focus.spec.ts`.

    await addComputer.click();
    await machineGoalDialog
      .getByRole('button', { name: /Run work on another computer over SSH/ })
      .click();
    await dialog.getByPlaceholder('box-b, or 192.168.1.20').fill('brian-media');
    const projectFolder = dialog.getByPlaceholder('~/code/my-project');
    await projectFolder.fill('~/dev/github/kontourai/station');
    await page.setViewportSize({ width: 390, height: 844 });
    await projectFolder.focus();
    await page.evaluate(() => {
      (
        window as Window & {
          __setTestVisualViewport?: (height: number) => void;
        }
      ).__setTestVisualViewport?.(430);
    });

    const submit = dialog.getByRole('button', { name: 'Save computer' });
    await submit.scrollIntoViewIfNeeded();
    await expect(submit).toBeInViewport();
    const panel = await page.locator('.station-dialog').boundingBox();
    expect(panel?.height).toBeLessThanOrEqual(430);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });

  test('mobile exposes the shared add-computer entry point plus observe, stop, and resume controls', async ({
    page,
  }) => {
    await seedRoutes(page, [
      environment({
        phase: 'connected',
        localUrl: 'http://127.0.0.1:43141',
        instanceId: 'remote-instance',
        sha: 'abcdef0',
        bootId: 'boot-1',
        connectedAt: '2026-07-18T00:00:00.000Z',
      }),
    ]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/connections/computers');

    await expect(
      page.getByRole('heading', { name: 'Computers', level: 1, exact: true }),
    ).toBeVisible();
    // `#section-environments` is gone with the old hub; a computer is a
    // `PageRow` whose label is a `<div>`, not a heading
    // (`views/connections-hub/ComputersSection.tsx:285-296`,
    // `components/PageRow.tsx:35`) — the same handle
    // `tests/connections-computers-ssh.spec.ts:326-330` already uses.
    const row = page
      .locator('.connections-computers__row')
      .filter({ hasText: 'Brian media' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('brian-media');
    await expect(row.locator('.connections-computers__state')).toHaveText(
      'Ready',
    );
    await expect(
      page
        .locator('.page__actions')
        .getByRole('button', { name: 'Add computer', exact: true }),
    ).toBeVisible();
    // The loopback forward address is never printed for an SSH computer: its
    // detail is `<hostAlias> · <remoteProjectPath>`
    // (`views/connections-hub/computer-rows.ts`), and nothing in that
    // derivation reads `state.localUrl`.
    await expect(page.getByText('http://127.0.0.1:43141')).toHaveCount(0);
    // Removal is a deliberate low-emphasis in-body control, not a peer of the
    // row's one action cell — asserting `Remove` absent was asserting the old
    // hub's shape.
    await expect(
      row.locator('.page-row__control').getByRole('button'),
    ).toHaveCount(1);
    await expect(
      row.getByRole('button', { name: 'Remove this computer' }),
    ).toBeVisible();

    const stop = row.getByRole('button', { name: 'Stop' });
    expect((await stop.boundingBox())?.height).toBeGreaterThanOrEqual(
      MIN_TOUCH_TARGET_PX,
    );
    await stop.click();
    await expect(row.locator('.connections-computers__state')).toHaveText(
      'Stopped',
    );
    await expect(row.getByRole('button', { name: 'Resume' })).toBeVisible();
  });
});
