import { expect, type Page, test } from '@playwright/test';
import { E2E_STATION_COMPATIBILITY } from './helpers/current-station-contract';

const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const CANARY_SECRET = 'credential-canary-never-render';

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

type RecoveryState = {
  profiles: Array<{ ref: string; label?: string }>;
  group: { profileRefs: string[]; enrolledProfileRefs: string[] };
  policy: { automatic: boolean };
  application: {
    capability: 'restart_resume' | 'unsupported';
    activeProfileRef?: string;
    pendingProfileRef?: string;
    outcome?: 'adopted' | 'rolled_back';
  };
};

async function seedCredentialRecoveryRoutes(
  page: Page,
  options: { capability?: 'restart_resume' | 'unsupported' } = {},
) {
  // This spec owns credential recovery, not first-run engine selection. Keep
  // the independently tested onboarding overlay from intercepting controls.
  await page.addInitScript(() => {
    window.localStorage.setItem('station:onboarding-setup-dismissed', '1');
  });
  const recovery: RecoveryState = {
    profiles: [{ ref: 'backup-profile', label: 'Backup profile' }],
    group: { profileRefs: ['backup-profile'], enrolledProfileRefs: [] },
    policy: { automatic: false },
    application: {
      capability: options.capability ?? 'restart_resume',
      activeProfileRef: 'primary-profile',
      pendingProfileRef: 'pending-profile',
    },
  };
  let applyCount = 0;
  const runtime = {
    id: 'claude',
    kind: 'agent',
    type: 'claude',
    name: 'Claude Code',
    enabled: true,
    status: 'ready',
    description: 'Mocked Claude Code engine.',
    capabilities: ['agent-runtime'],
    prerequisites: [],
    config: {
      executionClass: 'connected',
      providerLabel: 'Claude Code',
      // Credential profiles must remain visible even when this older base
      // app-home toggle is off.
      useAppHome: false,
    },
    setup: { state: 'ready', detected: true, configured: false },
  };

  await page.route('**/.well-known/station/v1', (route) =>
    route.fulfill(
      json({
        schemaVersion: 1,
        environmentId: ENVIRONMENT_ID,
        authentication: { scheme: 'bearer', protocolVersion: 1 },
        transports: { http: 1, sse: 1, websocket: 1 },
        compatibility: E2E_STATION_COMPATIBILITY,
      }),
    ),
  );
  await page.route('**/events', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const { pathname: path } = url;
    const method = route.request().method();
    const credentialRecoveryPrefix =
      '/api/connections/agent/claude/credential-recovery';

    if (path === '/api/auth/status') {
      await route.fulfill(json({ authenticated: true, user: null }));
      return;
    }
    if (path === '/api/system/identity') {
      await route.fulfill(
        json({
          environmentId: ENVIRONMENT_ID,
          instanceId: 'credential-recovery-fixture',
          bootId: 'credential-recovery-boot',
          sha: '1111111111111111111111111111111111111111',
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
            detected: {},
          },
          capabilities: { chat: { ready: true, source: 'mock' } },
        }),
      );
      return;
    }
    if (path === '/api/system/capabilities') {
      await route.fulfill(
        json({ runtime: 'mock', voice: { stt: [], tts: [] }, scheduler: true }),
      );
      return;
    }
    if (path === '/api/branding') {
      await route.fulfill(json({ success: true, data: {} }));
      return;
    }
    if (path === '/api/connections/agents') {
      await route.fulfill(json({ success: true, data: [runtime] }));
      return;
    }
    if (path === '/api/connections/claude') {
      await route.fulfill(json({ success: true, data: runtime }));
      return;
    }
    if (path === '/api/connections/agent/claude/app-home') {
      await route.fulfill(
        json({
          success: true,
          data: {
            exists: false,
            authState: 'unknown',
            keychainAuthPossible: false,
          },
        }),
      );
      return;
    }
    if (path === credentialRecoveryPrefix && method === 'GET') {
      await route.fulfill(json({ success: true, data: recovery }));
      return;
    }
    if (path === `${credentialRecoveryPrefix}/profiles` && method === 'POST') {
      const body = route.request().postDataJSON() as {
        ref: string;
        label?: string;
      };
      const existing = recovery.profiles.find(
        (profile) => profile.ref === body.ref,
      );
      if (existing) {
        existing.label = body.label;
      } else {
        recovery.profiles.push({ ref: body.ref, label: body.label });
        recovery.group.profileRefs.push(body.ref);
      }
      await route.fulfill(json({ success: true, data: recovery }));
      return;
    }
    const enrollment = path.match(
      /^\/api\/connections\/agent\/claude\/credential-recovery\/profiles\/([^/]+)\/enrollment$/,
    );
    if (enrollment && method === 'PUT') {
      const ref = decodeURIComponent(enrollment[1]);
      const body = route.request().postDataJSON() as { enrolled: boolean };
      recovery.group.enrolledProfileRefs = body.enrolled
        ? [...new Set([...recovery.group.enrolledProfileRefs, ref])]
        : recovery.group.enrolledProfileRefs.filter((entry) => entry !== ref);
      await route.fulfill(json({ success: true, data: recovery }));
      return;
    }
    if (path === `${credentialRecoveryPrefix}/policy` && method === 'PUT') {
      const body = route.request().postDataJSON() as { automatic: boolean };
      recovery.policy.automatic = body.automatic;
      await route.fulfill(json({ success: true, data: recovery }));
      return;
    }
    const profileAction = path.match(
      /^\/api\/connections\/agent\/claude\/credential-recovery\/profiles\/([^/]+)\/(import|apply)$/,
    );
    if (profileAction && method === 'POST') {
      const [, encodedRef, action] = profileAction;
      const ref = decodeURIComponent(encodedRef);
      if (action === 'import') {
        const body = route.request().postDataJSON() as {
          includeCredentials: boolean;
        };
        expect(body.includeCredentials).toBe(false);
        await route.fulfill(
          json({
            success: true,
            data: {
              outcome: 'completed',
              copied: ['settings.json', 'commands.json'],
              skipped: [{ path: CANARY_SECRET, reason: 'excluded' }],
              provenanceUpdated: true,
            },
          }),
        );
        return;
      }
      const body = route.request().postDataJSON() as { confirmed: boolean };
      expect(body.confirmed).toBe(true);
      applyCount += 1;
      recovery.application = {
        capability: recovery.application.capability,
        activeProfileRef: applyCount === 1 ? ref : 'primary-profile',
        outcome: applyCount === 1 ? 'adopted' : 'rolled_back',
      };
      await route.fulfill(json({ success: true, data: recovery.application }));
      return;
    }
    if (path === '/api/connections' && method === 'GET') {
      await route.fulfill(json({ success: true, data: [runtime] }));
      return;
    }
    // Every credential entry row mounts its own `CredentialProfileEnrolment`
    // (`views/AgentConnectionView.tsx:1278-1285`), inside the Advanced
    // `<details>` whose children React renders even while collapsed. The SDK
    // hands the route's payload straight through
    // (`packages/sdk/src/query-domains/workspaceConnections.ts:878-892`,
    // `result.data ?? {}` cast, no validation), so the catch-all's `[]` became
    // `{}`, passed the `error || !data` guard, and `data.command.command`
    // (`views/CredentialProfileEnrolment.tsx:73`) threw — taking the whole
    // route into its error boundary, which is why the Advanced disclosure could
    // not be found. Shape from `src-server/routes/connections/app-home.ts`;
    // `profileDir` is stripped client-side and is deliberately not modelled.
    const enrolmentStatus = path.match(
      /^\/api\/connections\/agent\/[^/]+\/enrolment\/[^/]+$/,
    );
    if (enrolmentStatus && method === 'GET') {
      await route.fulfill(
        json({
          success: true,
          data: {
            authState: 'unauthenticated',
            detail: 'Not logged in',
            command: {
              command: 'claude',
              args: ['auth', 'login'],
              env: { CLAUDE_CONFIG_DIR: '/managed/app-home' },
              description: 'Sign in to Claude for this credential entry.',
            },
          },
        }),
      );
      return;
    }
    if (path === '/api/agents' || path === '/api/projects') {
      await route.fulfill(json({ success: true, data: [] }));
      return;
    }
    await route.fulfill(json({ success: true, data: [] }));
  });
  return { recovery };
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'narrow', width: 390, height: 844 },
]) {
  test(`credential profile management is manual-first at ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const fixture = await seedCredentialRecoveryRoutes(page);
    await page.goto('/connections/engines/claude');

    // archive#1359 moved implementation-level engine controls behind the detail
    // view's Advanced disclosure. Credential profiles remain available there;
    // open the intentional disclosure rather than treating the new default
    // presentation as a missing recovery surface.
    const advanced = page.locator('details.provider-detail__advanced');
    await expect(advanced).toBeVisible();
    // Its own summary, not a nested one: each credential entry's enrolment
    // block renders a `Show sign-in command` <details> inside this one
    // (`views/CredentialProfileEnrolment.tsx:68-69`).
    await advanced.locator('> summary').click();

    await expect(
      page.getByRole('heading', { name: 'Credential entries' }),
    ).toBeVisible();
    await expect(
      page.getByRole('checkbox', {
        name: /Run sessions in a Station-managed app home/,
      }),
    ).not.toBeChecked();
    await expect(
      page.getByText('Pending verification: pending-profile'),
    ).toBeVisible();
    await expect(
      page.getByRole('checkbox', {
        name: /Automatically try an enrolled credential entry/,
      }),
    ).not.toBeChecked();
    // Finish the pre-existing staged attempt before exercising a new manual
    // application. The product deliberately disables competing applications
    // while a candidate is pending.
    delete fixture.recovery.application.pendingProfileRef;
    await page.reload();
    await expect(advanced).toBeVisible();
    // Its own summary, not a nested one: each credential entry's enrolment
    // block renders a `Show sign-in command` <details> inside this one
    // (`views/CredentialProfileEnrolment.tsx:68-69`).
    await advanced.locator('> summary').click();
    await expect(
      page.getByRole('heading', { name: 'Credential entries' }),
    ).toBeVisible();

    await page
      .getByRole('textbox', { name: 'Credential entry reference' })
      .fill('new-profile');
    await page
      .getByRole('textbox', { name: 'Credential entry label' })
      .fill('New profile');
    await page.getByRole('button', { name: 'Add credential entry' }).click();
    await expect(page.getByText('New profile', { exact: true })).toBeVisible();

    const backup = page.locator('.credential-recovery__profile', {
      hasText: 'Backup profile',
    });
    await backup
      .getByRole('textbox', { name: 'Label for backup-profile' })
      .fill('Renamed backup');
    await backup.getByRole('button', { name: 'Save label' }).click();
    await expect(
      page.getByText('Renamed backup', { exact: true }),
    ).toBeVisible();
    const renamedBackup = page.locator('.credential-recovery__profile', {
      hasText: 'Renamed backup',
    });
    const enrollmentCheckbox = renamedBackup.getByRole('checkbox', {
      name: 'Allow automatic recovery selection',
    });
    // This is a mutation-controlled input: the checked state is committed
    // only after the server projection returns.
    await renamedBackup
      .getByText('Allow automatic recovery selection', { exact: true })
      .click({ force: true });
    await expect(enrollmentCheckbox).toBeChecked();

    await page
      .getByRole('button', { name: 'Import into Renamed backup' })
      .click();
    const importResult = page.getByRole('status', {
      name: 'Credential entry provisioning import result',
    });
    await expect(importResult).toContainText(
      'Provisioning import completed: 2 items copied; 1 item skipped.',
    );
    await expect(importResult).toContainText(
      'This credential entry is marked as imported.',
    );
    await expect(page.getByText(CANARY_SECRET)).toHaveCount(0);
    await expect(page.getByText('settings.json')).toHaveCount(0);

    await renamedBackup.getByRole('button', { name: 'Apply manually' }).click();
    await expect(
      page.getByText(/potentially billable engine turn/),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Apply and verify' }).click();
    await expect(
      page.getByText('Credential application: adopted.'),
    ).toBeVisible();

    // A later failure must name rollback, never report success.
    await renamedBackup.getByRole('button', { name: 'Apply manually' }).click();
    await page.getByRole('button', { name: 'Apply and verify' }).click();
    await expect(
      page.locator('.credential-recovery__outcome[role="alert"]'),
    ).toContainText(
      'Credential application was rolled back; the active credential was not changed.',
    );
  });
}

test('unsupported credential profile capability fails closed', async ({
  page,
}) => {
  await seedCredentialRecoveryRoutes(page, { capability: 'unsupported' });
  await page.goto('/connections/engines/claude');

  const advanced = page.locator('details.provider-detail__advanced');
  await expect(advanced).toBeVisible();
  // Its own summary, not a nested one: each credential entry's enrolment
  // block renders a `Show sign-in command` <details> inside this one.
  await advanced.locator('> summary').click();
  const recovery = page.locator('.credential-recovery');

  await expect(
    recovery.getByText('Not supported', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', {
      name: /Automatically try an enrolled credential entry/,
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Apply manually' }),
  ).toBeDisabled();
});
