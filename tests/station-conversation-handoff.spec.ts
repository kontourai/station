import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PeerConversationHandoffReceiptV1 } from '@kontourai/station-contracts/peer-chat';
import { expect, type Page, type TestInfo } from '@playwright/test';
import {
  startConnectionChat,
  stationJson,
  test,
} from './helpers/peer-chat-stations';
import { runSetupControl } from './helpers/run-setup';

// The source Station needs its own model to hold the conversation first.
test.use({ hostModel: true });
test.setTimeout(600_000);

/** Reviewed by hand: the handoff picker and the continued chat, both themes, two widths. */
async function shoot(page: Page, testInfo: TestInfo, name: string) {
  const original = page.viewportSize();
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const file = `${name}-${width}-${scheme}.png`;
      await page.screenshot({ path: testInfo.outputPath(file) });
      // A passing run's output is removed; this keeps the reviewed images.
      const keep = process.env.MACHINE_HANDOFF_SHOT_DIR;
      if (keep) {
        mkdirSync(keep, { recursive: true });
        copyFileSync(testInfo.outputPath(file), join(keep, file));
      }
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  if (original) await page.setViewportSize(original);
}

test('a conversation continues on a paired Station with its history, and a retry reuses it', async ({
  page,
  stations,
}, testInfo) => {
  const { source, receiverId, streams } = stations;
  const transcript = page.getByRole('log', { name: 'Conversation transcript' });
  await startConnectionChat(
    page,
    'host',
    'Plan the receiver migration in two steps.',
  );
  await expect.poll(() => streams.length).toBe(1);
  expect(streams[0]!.station).toBe('source');
  streams[0]!.stream.text(
    'Step one: copy the schema. Step two: switch traffic.',
  );
  streams[0]!.stream.finish();
  await expect(transcript).toContainText('Step two: switch traffic.');
  await expect(page.getByPlaceholder(/^Type a message/)).toBeEditable();

  const agentTrigger = await runSetupControl(page, (panel) =>
    panel.getByRole('button', { name: /^Agent: .*\. Change Agent$/ }),
  );
  await agentTrigger.click();
  const picker = page.getByRole('dialog', { name: 'Switch agent' });
  await expect(picker).toBeVisible();
  await picker
    .getByRole('radiogroup', { name: 'Station' })
    .getByRole('radio', { name: 'Receiver' })
    .check();
  // Choosing another Station makes it a move, and the dialog says so.
  const dialog = page.getByRole('dialog', { name: 'Continue elsewhere' });
  await expect(dialog).toBeVisible();
  const project = dialog.getByLabel('Project on Receiver');
  await expect(project).toBeEnabled();
  await project.selectOption({ label: 'Receiver work' });
  const submit = dialog.getByRole('button', {
    name: 'Continue on Receiver',
    exact: true,
  });
  await expect(submit).toBeEnabled();
  await dialog.getByRole('button', { name: 'Details' }).click();
  await expect(dialog).toContainText('Files · Tool output · Attachments');
  await shoot(page, testInfo, 'picker');

  const handoffPath = `/api/environments/peers/${receiverId}/conversation-handoffs`;
  const handoff = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === handoffPath,
  );
  const relayedChat = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname ===
        `/api/environments/peers/${receiverId}/chat-api/api/orchestration/chat`,
  );
  await submit.click();
  const handoffResponse = await handoff;
  expect(handoffResponse.status()).toBe(200);
  const receipt = (
    (await handoffResponse.json()) as {
      data: PeerConversationHandoffReceiptV1;
    }
  ).data;
  expect(receipt).toMatchObject({
    environmentId: receiverId,
    carriedMessages: 2,
    omittedMessages: 0,
    idempotent: false,
  });
  // The first turn goes to the imported conversation, through the relay.
  const chatResponse = await relayedChat;
  expect(chatResponse.ok()).toBe(true);
  expect(chatResponse.request().postDataJSON()).toMatchObject({
    conversationId: receipt.conversationId,
    target: {
      environment: { kind: 'current' },
      workspace: { kind: 'project', projectSlug: 'receiver-work' },
    },
  });

  // The receiver's engine is told what came before.
  await expect.poll(() => streams.length).toBe(2);
  expect(streams[1]!.station).toBe('receiver');
  const seen = JSON.stringify(streams[1]!.request);
  expect(seen).toContain('Plan the receiver migration in two steps.');
  expect(seen).toContain('Step two: switch traffic.');
  streams[1]!.stream.text('Receiver here: starting with step one.');
  streams[1]!.stream.finish();
  await expect(transcript).toContainText(
    'Receiver here: starting with step one.',
  );
  await expect(page.getByText('Via Receiver', { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder(/^Type a message/)).toBeEditable();
  await shoot(page, testInfo, 'continued');

  // The receiver owns the new conversation: after a reload the dock reads it
  // back from there. A relayed tab reads events only, so it shows messages
  // from the handoff on; the carried rows are the receiver's own record and
  // reached its engine (asserted above).
  await page.reload();
  await expect(transcript).toContainText(
    'Receiver here: starting with step one.',
  );
  await expect(transcript).toContainText(
    'You are taking over this conversation.',
  );
  await expect(page.getByText('Via Receiver', { exact: true })).toBeVisible();
  await shoot(page, testInfo, 'continued-reloaded');
  // The source conversation is left as it was: still one Session there.
  const sourceSessions = await stationJson<{ data: unknown[] }>(
    source,
    '/api/orchestration/sessions',
  );
  expect(sourceSessions.data).toHaveLength(1);

  // A retry of the same request (a lost answer) creates nothing new.
  const replay = await page.evaluate(
    async ({ url, body, headers }) => {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        credentials: 'include',
      });
      return { status: response.status, body: await response.json() };
    },
    {
      url: handoffResponse.url(),
      body: handoffResponse.request().postData() ?? '',
      headers: Object.fromEntries(
        Object.entries(await handoffResponse.request().allHeaders()).filter(
          ([name]) => name === 'content-type' || name.startsWith('x-'),
        ),
      ),
    },
  );
  expect(replay.status).toBe(200);
  expect(replay.body.data).toMatchObject({
    conversationId: receipt.conversationId,
    idempotent: true,
  });
  expect(streams).toHaveLength(2);
});
