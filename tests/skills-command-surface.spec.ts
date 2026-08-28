import { expect, type Page } from '@playwright/test';
import {
  deleteAgent,
  openChatWithAgent,
  readyAgentConnections,
  seedAgent,
  waitForAgentRemoved,
  waitForSeededAgent,
} from './helpers/agents-journey';
import {
  type AuthenticatedE2ERequest,
  test,
} from './helpers/authenticated-request';

/**
 * E6 — making a skill runnable as a `/command`, against a REAL Station.
 *
 * `tests/skills.spec.ts` already covers the switch and the Commands catalogue
 * with `page.route` fixtures; this file deliberately does not repeat that. It
 * covers the two claims a mocked skills API cannot make:
 *
 *  1. the composer offers the new `/command` — the surface `useSlashCommands`
 *     builds from the live skills catalogue, one route away from the switch
 *     that created it;
 *  2. a command word nobody can type is REFUSED, with the naming rule
 *     (`SKILL_COMMAND_NAME_PATTERN`, `packages/contracts/src/skill-command.ts`)
 *     said out loud. The server already refuses it — the claim under test is
 *     that the person who pressed Save is told.
 *
 * Live, so it is `shared-instance-exclusive`: the skill is created and deleted
 * through `POST/DELETE /api/skills/local` on the instance under test.
 */

const SKILL = 'e2e-command-skill';
const COMMAND = 'e2e-command-skill';
const BODY = 'Ship {{ticket}} now';
const UNTYPABLE_WORD = 'Ship It';
const NAMING_MESSAGE = /lowercase letters, digits and dashes/i;

async function seedSkill(request: AuthenticatedE2ERequest): Promise<void> {
  await request.delete(`/api/skills/${SKILL}`);
  const created = await request.post('/api/skills/local', {
    data: { name: SKILL, description: 'E2E command skill', body: BODY },
  });
  expect(created.ok()).toBe(true);
  const body = (await created.json()) as { success?: boolean; error?: string };
  expect(
    body.success,
    `seeding the skill failed: ${body.error ?? 'no reason given'}`,
  ).toBe(true);
}

const CHAT_AGENT_SLUG = 'e2e-command-surface-chat';
const CHAT_AGENT_NAME = 'E2E Command Surface Chat';

/**
 * The chat target this spec needs, seeded BY this spec.
 *
 * The built-in `station` Agent is not it: Station's own engine needs a
 * resolvable managed model, and an E2E instance boots with `defaultModel: ""`
 * and no model connection at all — so the server reports it
 * `available: false` / "No enabled LLM provider connection is configured.",
 * and the editor's Chat action, which renders only for a runnable agent
 * (`views/agent-editor/AgentsViewEditorPane.tsx`), never appears. That is not
 * residue: it reproduces with this spec run entirely alone.
 *
 * An AUTHORED agent bound to an engine connection the SERVER reports ready
 * satisfies both halves the picker composes (`agentRunnability` and
 * `canAgentStartChat`), and needs no connection write — which matters here,
 * because every `/api/connections` write moves the runtime's launchability
 * revision and drops the whole instance into the stale-catalog path that the
 * sibling agents spec has to wait out.
 */
async function seedChatAgent(request: AuthenticatedE2ERequest): Promise<void> {
  const ready = await readyAgentConnections(request);
  const engine = ready.find((connection) =>
    ['claude', 'codex', 'muse'].includes(connection.id),
  );
  expect(
    engine,
    'no installed CLI engine connection is ready on this host, so no agent on it can be chatted with',
  ).toBeTruthy();
  await deleteAgent(request, CHAT_AGENT_SLUG);
  await waitForAgentRemoved(request, CHAT_AGENT_SLUG);
  await seedAgent(request, {
    slug: CHAT_AGENT_SLUG,
    name: CHAT_AGENT_NAME,
    prompt: 'You are the command-surface chat fixture.',
    execution: { agentConnectionId: (engine as { id: string }).id },
  });
  await waitForSeededAgent(request, CHAT_AGENT_SLUG);
}

async function openSkill(page: Page): Promise<void> {
  await page.goto('/guidance?tab=skills');
  await page.waitForSelector('.split-pane', { timeout: 20_000 });
  await page
    .locator('.split-pane__item')
    .filter({ hasText: SKILL })
    .first()
    .click();
  await expect(page.locator('#skill-body')).toHaveValue(BODY, {
    timeout: 20_000,
  });
}

/** The detail pane's Save, never the phone footer's — both are named "Save". */
function detailSave(page: Page) {
  return page
    .locator('.split-pane__right')
    .getByRole('button', { name: 'Save', exact: true });
}

test.describe('Skill commands', () => {
  test.beforeEach(async ({ authenticatedRequest }) => {
    await seedSkill(authenticatedRequest);
    await seedChatAgent(authenticatedRequest);
  });

  test.afterEach(async ({ authenticatedRequest }) => {
    await authenticatedRequest.delete(`/api/skills/${SKILL}`);
    await deleteAgent(authenticatedRequest, CHAT_AGENT_SLUG);
    await waitForAgentRemoved(authenticatedRequest, CHAT_AGENT_SLUG);
  });

  test('turning the command switch on puts /<command> in the chat composer', async ({
    page,
    authenticatedRequest,
  }) => {
    test.setTimeout(120_000);
    await openSkill(page);

    await page
      .getByRole('switch', { name: 'Runnable as a slash command' })
      .click();
    await page.getByRole('switch', { name: 'Offer to every agent' }).click();
    await detailSave(page).click();

    // The server is the authority on whether it is a command now.
    await expect
      .poll(
        async () => {
          const response = await authenticatedRequest.get(
            `/api/skills/${SKILL}`,
          );
          const body = (await response.json()) as {
            data?: { command?: { enabled?: boolean } };
          };
          return body.data?.command?.enabled === true;
        },
        { timeout: 20_000 },
      )
      .toBe(true);

    // …and the composer offers it. Typing "/" is what a person does; the
    // selector is built from the live skills catalogue by `useSlashCommands`.
    // Open the agent, then chat from ITS editor — `openChatWithAgent` is the
    // beat the Agents specs share. Addressed by URL rather than by picking a
    // rail row out of a text filter: every row carries its engine's name as a
    // chip, so `hasText: 'Station'` matches any Station-engine agent another
    // spec happens to have left on the instance, and the filter selected a
    // different row once one existed.
    await page.goto(`/agents/${CHAT_AGENT_SLUG}`);
    await expect(page.locator('.agent-inline-editor')).toBeVisible({
      timeout: 20_000,
    });
    // The editor offers Chat only for an agent the SERVER calls runnable, so
    // assert it here — an unrunnable precondition should fail on the
    // affordance, not thirty seconds later inside the shared helper.
    await expect(
      page
        .locator('.agent-inline-editor')
        .getByRole('button', { name: 'Chat', exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await openChatWithAgent(page, CHAT_AGENT_NAME);

    const composer = page.getByPlaceholder('Type a message...');
    await composer.click();
    await composer.pressSequentially('/');

    const dock = page.locator('#chat-dock, #chat-workspace-pane');
    await expect(dock.getByText(`/${COMMAND}`, { exact: true })).toBeVisible({
      timeout: 20_000,
    });
  });

  test('a command word nobody can type is refused, and the refusal says the naming rule', async ({
    page,
  }) => {
    await openSkill(page);

    await page
      .getByRole('switch', { name: 'Runnable as a slash command' })
      .click();
    await page.locator('#skill-command-name').fill(UNTYPABLE_WORD);

    // The half under test: the person is told, in the words of the rule they
    // broke. A refusal nobody sees leaves the editor advertising
    // "Type /Ship It in chat" for a command that does not exist.
    await expect(page.getByText(NAMING_MESSAGE).first()).toBeVisible({
      timeout: 10_000,
    });

    // …and nothing on the page claims the refused word is typable.
    await expect(page.getByText(`Type /${UNTYPABLE_WORD} in chat`)).toHaveCount(
      0,
    );

    // archive#3737 landed the rule as ONE derivation shared by the HTTP
    // schema and this field, so the refusal now happens at the field: Save
    // sends nothing, and the 400 this test used to wait for is unreachable
    // from here. The claim is unchanged — the person is told what they broke.
    const writes: number[] = [];
    page.on('response', (response) => {
      if (
        response.request().method() === 'PUT' &&
        new URL(response.url()).pathname === `/api/skills/${SKILL}`
      ) {
        writes.push(response.status());
      }
    });
    await detailSave(page).click();
    await expect(page.getByText(NAMING_MESSAGE).first()).toBeVisible({
      timeout: 10_000,
    });
    expect(writes).toEqual([]);
  });
});

test.describe('Skill commands at 390x844', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test.beforeEach(async ({ authenticatedRequest }) => {
    await seedSkill(authenticatedRequest);
  });

  test.afterEach(async ({ authenticatedRequest }) => {
    await authenticatedRequest.delete(`/api/skills/${SKILL}`);
  });

  test('the command switch and its command word are usable on a phone', async ({
    page,
    authenticatedRequest,
  }) => {
    await openSkill(page);

    await page
      .getByRole('switch', { name: 'Runnable as a slash command' })
      .click();
    await expect(page.locator('#skill-command-name')).toBeVisible();
    await expect(page.getByText(`Type /${COMMAND} in chat`)).toBeVisible();

    const noHorizontalScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(noHorizontalScroll).toBe(true);

    await detailSave(page).click();
    await expect
      .poll(
        async () => {
          const response = await authenticatedRequest.get(
            `/api/skills/${SKILL}`,
          );
          const body = (await response.json()) as {
            data?: { command?: { enabled?: boolean } };
          };
          return body.data?.command?.enabled === true;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
  });
});
