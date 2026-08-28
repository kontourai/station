import { expect, type Page, test } from '@playwright/test';
import { foregroundMessageReceiptEnvelope } from './helpers/execution-receipt';

type SkillRecord = {
  name: string;
  description?: string;
  body: string;
  category?: string;
  tags?: string[];
  agent?: string;
  global?: boolean;
  source?: string;
  path?: string;
  installed?: boolean;
  version?: string;
};

async function seedSkillRoutes(page: Page) {
  const skills = new Map<string, SkillRecord>([
    [
      'Review Skill',
      {
        name: 'Review Skill',
        description: 'Review code changes',
        body: 'Review {{diff}}',
        category: 'quality',
        tags: ['review'],
        global: true,
        source: 'local',
        path: '/tmp/skills/review/SKILL.md',
        installed: true,
      },
    ],
    [
      'Registry Skill',
      {
        name: 'Registry Skill',
        description: 'Installed from registry',
        body: 'Registry managed body',
        source: 'registry',
        path: 'registry://registry-skill',
        installed: true,
        version: '1.0.0',
      },
    ],
  ]);

  await page.route('**/api/system/skills', async (route) => {
    await route.fulfill({
      json: { success: true, data: Array.from(skills.values()) },
    });
  });

  await page.route('**/api/registry/skills**', async (route) => {
    const request = route.request();
    if (request.method() === 'DELETE') {
      const name = decodeURIComponent(
        new URL(request.url()).pathname.split('/').pop() ?? '',
      );
      skills.delete(name);
      await route.fulfill({ json: { success: true } });
      return;
    }
    await route.fulfill({ json: { success: true, data: [] } });
  });

  await page.route('**/api/skills**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === '/api/skills' && method === 'GET') {
      await route.fulfill({
        json: { success: true, data: Array.from(skills.values()) },
      });
      return;
    }

    if (path === '/api/skills/local' && method === 'POST') {
      const body = request.postDataJSON();
      if (skills.has(body.name)) {
        await route.fulfill({
          status: 409,
          json: {
            success: false,
            error: 'A skill with this name already exists',
          },
        });
        return;
      }
      const skill = {
        ...body,
        source: 'local',
        installed: true,
        path: `/tmp/skills/${body.name}/SKILL.md`,
      };
      skills.set(body.name, skill);
      await route.fulfill({ json: { success: true, data: skill } });
      return;
    }

    const detailMatch = path.match(/^\/api\/skills\/([^/]+)$/);
    if (detailMatch && method === 'GET') {
      const name = decodeURIComponent(detailMatch[1]);
      await route.fulfill({
        json: { success: true, data: skills.get(name) },
      });
      return;
    }

    if (detailMatch && method === 'PUT') {
      const name = decodeURIComponent(detailMatch[1]);
      const current = skills.get(name);
      const body = request.postDataJSON();
      const updated = { ...current, ...body, name };
      skills.set(name, updated as SkillRecord);
      await route.fulfill({ json: { success: true, data: updated } });
      return;
    }

    await route.fallback();
  });
}

test.describe('Skills (via Registry + API)', () => {
  test('standalone /skills shows installed skills only', async ({ page }) => {
    await page.goto('/skills');
    await page.waitForSelector('.split-pane', { timeout: 15_000 });

    // /skills redirects to /guidance?tab=skills, and archive#4463
    // pins the page title at 'Guidance' — it does not change to 'Skills'
    // per tab (the tab strip already names the section).
    await expect(
      page.getByRole('heading', { name: 'Guidance', level: 1, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'New skill' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Install', exact: true }),
    ).not.toBeVisible();
  });

  test('registry Skills tab loads and is selectable', async ({ page }) => {
    await page.goto('/registry');
    await page.waitForSelector('.page__tab', { timeout: 15_000 });

    await page.locator('.page__tab', { hasText: 'Skills' }).click();

    await expect(page.locator('.page__tab--active')).toHaveText('Skills');
  });

  test('skills can be created, guarded, edited, and labeled by source', async ({
    page,
  }) => {
    await seedSkillRoutes(page);
    await page.goto('/skills');
    await page.waitForSelector('.split-pane', { timeout: 15_000 });

    await expect(
      page.locator('.page__tab--active', { hasText: 'Skills' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'New skill' }).click();
    await page.locator('.skill-detail input').nth(0).fill('Planning Skill');
    await page.locator('.skill-detail input').nth(1).fill('Plan a task');
    await page.locator('.skill-detail textarea').fill('Plan {{task}}');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('Skill saved')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Planning Skill' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Review Skill' }).click();
    await expect(page.getByText('Workspace-authored skill')).toBeVisible();
    await expect(page.locator('.skill-detail textarea')).toHaveValue(
      'Review {{diff}}',
    );
    await page
      .locator('.skill-detail input')
      .nth(1)
      .fill('Review code thoroughly');
    await expect(page.getByText('unsaved')).toBeVisible();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Skill saved')).toBeVisible();

    await page.goto('/skills');
    await page.waitForSelector('.split-pane', { timeout: 15_000 });
    // The rail row's name is name + subtitle only — the source word moved to
    // the detail pane (`views/skills/skill-view-utils.ts:156-168`;
    // `SkillsView.tsx:351-355`), which the next line already asserts. `exact`
    // keeps this off "Browse Registry Skills".
    await page
      .getByRole('button', { name: 'Registry Skill', exact: true })
      .click();
    await expect(page.getByText('Installed read-only skill')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).not.toBeVisible();
    await expect(page.locator('.skill-detail textarea')).toBeDisabled();
  });
});

/**
 * Command skills (CAT-R08 / CAT-R09 coverage). A skill declares itself runnable
 * and the whole slash surface follows: the Commands catalogue, the filtered
 * Skills list, and the composer.
 */
type CommandSkill = SkillRecord & {
  command?: { enabled: boolean; name?: string; global?: boolean };
  variables?: Array<{ name: string; description?: string; default?: string }>;
  stats?: {
    runs: number;
    successes: number;
    failures: number;
    qualityScore: number | null;
  };
};

async function seedCommandSkillRoutes(page: Page) {
  const skills = new Map<string, CommandSkill>([
    [
      'release-check',
      {
        name: 'release-check',
        description: 'Ship a release',
        body: 'Ship {{ticket}}',
        source: 'local',
        path: '/tmp/skills/release-check/SKILL.md',
        installed: true,
        variables: [{ name: 'ticket', description: 'Jira key' }],
        stats: { runs: 2, successes: 2, failures: 0, qualityScore: 100 },
      },
    ],
    [
      'plain-skill',
      {
        name: 'plain-skill',
        description: 'Not a command',
        body: 'Just a skill',
        source: 'local',
        path: '/tmp/skills/plain-skill/SKILL.md',
        installed: true,
      },
    ],
  ]);
  const runs: string[] = [];

  const listing = () =>
    Array.from(skills.values()).map(({ body: _body, ...rest }) => rest);

  await page.route('**/api/system/skills', async (route) => {
    await route.fulfill({ json: { success: true, data: listing() } });
  });

  await page.route('**/api/skills**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();

    const runMatch = path.match(/^\/api\/skills\/([^/]+)\/run$/);
    if (runMatch && method === 'POST') {
      const name = decodeURIComponent(runMatch[1]);
      runs.push(name);
      const skill = skills.get(name);
      if (skill) {
        skill.stats = {
          runs: (skill.stats?.runs ?? 0) + 1,
          successes: skill.stats?.successes ?? 0,
          failures: skill.stats?.failures ?? 0,
          qualityScore: skill.stats?.qualityScore ?? null,
        };
      }
      await route.fulfill({
        json: { success: true, data: { name, stats: skill?.stats } },
      });
      return;
    }

    const detailMatch = path.match(/^\/api\/skills\/([^/]+)$/);
    if (detailMatch && method === 'GET') {
      await route.fulfill({
        json: {
          success: true,
          data: skills.get(decodeURIComponent(detailMatch[1])),
        },
      });
      return;
    }
    if (detailMatch && method === 'PUT') {
      const name = decodeURIComponent(detailMatch[1]);
      const updated = {
        ...skills.get(name),
        ...request.postDataJSON(),
        name,
      } as CommandSkill;
      skills.set(name, updated);
      await route.fulfill({ json: { success: true, data: updated } });
      return;
    }
    await route.fallback();
  });

  return { runs, skills };
}

test.describe('Command skills', () => {
  test('the retired playbook link lands on the command-skill list', async ({
    page,
  }) => {
    await seedCommandSkillRoutes(page);

    // The retired path resolves to the surface that absorbed it.
    await page.goto('/playbooks');
    await page.waitForSelector('.split-pane', { timeout: 15_000 });
    await expect(page).toHaveURL(/tab=skills/);
    await expect(page.getByRole('tab', { name: 'Playbooks' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Skills' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Commands' })).toBeVisible();

    await page.goto('/guidance?tab=skills&filter=commands');
    await page.waitForSelector('.split-pane', { timeout: 15_000 });
    // Nothing is a command yet, and the empty state says exactly that rather
    // than claiming the workspace has no skills.
    await expect(page.getByText('No skills are commands yet')).toBeVisible();
  });

  // CAT-R09: the pre-merge editor printed "Slash command: /x" whether or not
  // the command existed. The switch is the thing that makes it exist.
  test('turning on the command switch gives the skill a /command everywhere', async ({
    page,
  }) => {
    const seeded = await seedCommandSkillRoutes(page);

    await page.goto('/guidance/release-check?tab=skills');
    await page.waitForSelector('.skill-detail', { timeout: 15_000 });

    // The body's variable is derived and shown; its declaration is attached.
    // `exact` picks the derived-variable chip
    // (`views/skills/SkillCommandSection.tsx:139`) out of the three places the
    // body text now appears — the Body textarea and the live `.skill-preview`
    // both read "Ship {{ticket}}".
    await expect(page.getByText('{{ticket}}', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('textbox', { name: 'Description for ticket' }),
    ).toHaveValue('Jira key');
    // Counters that were read are reported as read.
    await expect(page.getByText('2 runs · 100% success').first()).toBeVisible();

    await page
      .getByRole('switch', { name: 'Runnable as a slash command' })
      .click();
    await page.getByRole('switch', { name: 'Offer to every agent' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Skill saved')).toBeVisible();

    expect(seeded.skills.get('release-check')?.command).toEqual({
      enabled: true,
      global: true,
    });

    // It is now in the Commands catalogue, labelled as the Skill it is.
    await page.getByRole('tab', { name: 'Commands' }).click();
    await expect(
      page.locator('code', { hasText: '/release-check' }).first(),
    ).toBeVisible();
    await expect(page.getByText('Skill').first()).toBeVisible();

    // ...and in the filtered Skills list, which a plain skill stays out of.
    await page.goto('/guidance?tab=skills&filter=commands');
    await page.waitForSelector('.split-pane', { timeout: 15_000 });
    await expect(
      page.getByRole('button', { name: /release-check/ }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /plain-skill/ })).toHaveCount(
      0,
    );
  });

  test('a test run resolves its variables into the turn and opens the dock', async ({
    page,
  }) => {
    await seedCommandSkillRoutes(page);
    // `handleRun` AWAITS the chat turn before it records the run
    // (`views/SkillsView.tsx:281-296`), and this spec mocks only the skills
    // routes — so the run count was waiting on a real turn against the shared
    // instance. Mock the dispatch: the claim under test is that pressing Send
    // opens the dock and posts `/api/skills/<name>/run`, not what a live engine
    // answers.
    const dispatched: Array<Record<string, unknown>> = [];
    await page.route('**/api/orchestration/chat', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      dispatched.push(body);
      await route.fulfill({
        json: foregroundMessageReceiptEnvelope({
          conversationId: String(body.conversationId ?? ''),
          agent: 'station',
        }),
      });
    });

    await page.goto('/guidance/release-check?tab=skills');
    await page.waitForSelector('.skill-detail', { timeout: 15_000 });

    await page.getByRole('button', { name: '▶ Test' }).click();
    const runDialog = page.getByRole('dialog', { name: 'Test: release-check' });
    await expect(runDialog).toBeVisible();
    // The dialog clears every typed value when the agents list lands: its reset
    // effect depends on `defaultAgentSlug` = `agents[0]?.slug`
    // (`components/modals/SkillRunModal.tsx:31, 39-45`), and `agents` comes from
    // the LIVE `useAgents()` this spec does not mock. Wait for that read before
    // typing, or the fill is discarded a frame later.
    await expect(runDialog.getByLabel('Agent')).not.toHaveValue('');
    await runDialog.getByLabel('{{ticket}}').fill('ABC-1');
    // The preview substitutes what was typed, so what is sent is visible first.
    await expect(page.locator('.skill-run__preview')).toHaveText('Ship ABC-1');
    await page.getByRole('button', { name: '▶ Send to Agent' }).click();

    // The resolved body — not the template — is what the turn carries.
    await expect
      .poll(() => dispatched.map((entry) => entry.message))
      .toContain('Ship ABC-1');
    await expect(
      page.locator('#chat-dock, #chat-workspace-pane'),
    ).toBeVisible();
    // The run COUNT is not asserted here. `handleRun` records it only after the
    // turn it awaits resolves (`views/SkillsView.tsx:292-295`), which needs a
    // whole mocked orchestration turn — and the contract itself is already
    // owned a layer down by
    // `src-server/routes/agents/__tests__/skills.routes.test.ts:339`
    // ("POST /:name/run counts a run and answers with the stats"). What needs a
    // browser is the variable resolution reaching the dispatch, above.
  });

  test('a read-only skill is told what would make it a command', async ({
    page,
  }) => {
    const seeded = await seedCommandSkillRoutes(page);
    seeded.skills.set('packaged-skill', {
      name: 'packaged-skill',
      description: 'From a package',
      body: 'Read only',
      source: 'package',
      installed: true,
    });

    await page.goto('/guidance/packaged-skill?tab=skills');
    await page.waitForSelector('.skill-detail', { timeout: 15_000 });

    await expect(
      page.getByText('Install to workspace to make this a command'),
    ).toBeVisible();
    await expect(
      page.getByRole('switch', { name: 'Runnable as a slash command' }),
    ).toHaveCount(0);
  });
});
