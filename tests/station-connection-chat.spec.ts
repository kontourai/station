import { PEER_CHAT_UPLOAD_GRANT_HEADER } from '@kontourai/station-contracts/peer-chat';
import { expect } from '@playwright/test';
import {
  captureConnectionState,
  startConnectionChat,
  stationJson,
  test,
} from './helpers/peer-chat-stations';

test.setTimeout(600_000);

test('owner Device chats through a real Station delegation and keeps target refusal separate from source authentication', async ({
  page,
  stations,
}, testInfo) => {
  test.setTimeout(600_000);
  const { receiver, source, streams } = stations;
  const receipt = await startConnectionChat(
    page,
    'relay',
    'Check the receiver project.',
  );
  expect(receipt.conversationId).toBeTruthy();
  const transcript = page.getByRole('log', { name: 'Conversation transcript' });
  await expect.poll(() => streams.length).toBe(1);
  expect(streams[0]!.station).toBe('receiver');
  streams[0]!.stream.text('Receiver streamed this before completion.');
  await expect(transcript).toContainText(
    'Receiver streamed this before completion.',
  );
  await expect(page.getByText('Via Receiver', { exact: true })).toBeVisible();
  await captureConnectionState(page, testInfo, 'relay-streaming');
  const sourceSessions = await stationJson<{ data: unknown[] }>(
    source,
    '/api/orchestration/sessions',
  );
  expect(sourceSessions.data).toEqual([]);
  // A real read-only tool request still follows the receiver's approval policy.
  expect(streams[0]!.offeredTools).toContain(
    'stationDocs_listStationDocsTopics',
  );
  streams[0]!.stream.tool(
    'stationDocs_listStationDocsTopics',
    {},
    'receiver-topics',
  );
  streams[0]!.stream.finish('tool_calls');
  await expect(
    page.getByRole('button', { name: 'Allow Once', exact: true }),
  ).toBeEnabled();
  await captureConnectionState(page, testInfo, 'relay-approval');
  await page.getByRole('button', { name: 'Allow Once', exact: true }).click();
  await expect.poll(() => streams.length).toBe(2);
  streams[1]!.stream.text('The approved receiver tool completed.');
  streams[1]!.stream.finish();
  await expect(transcript).toContainText(
    'The approved receiver tool completed.',
  );
  const composer = page.getByPlaceholder(/^Type a message/);
  await expect(composer).toBeEditable();
  await captureConnectionState(page, testInfo, 'relay-idle');
  await composer.fill('Follow up on the same receiver conversation.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => streams.length).toBe(3);
  streams[2]!.stream.text('This turn remains running until Stop.');
  await expect(transcript).toContainText(
    'This turn remains running until Stop.',
  );
  await page.evaluate(() =>
    window.stationConnectionFaults.disconnectEvents(true),
  );
  await expect(page.getByText('Reconnecting…', { exact: true })).toBeVisible();
  await captureConnectionState(page, testInfo, 'relay-reconnect');
  streams[2]!.stream.text('Receiver text retained during disconnect.');
  await expect(transcript).not.toContainText(
    'Receiver text retained during disconnect.',
  );
  await page.evaluate(() =>
    window.stationConnectionFaults.disconnectEvents(false),
  );
  await expect(transcript).toContainText(
    'Receiver text retained during disconnect.',
  );
  await page
    .getByRole('button', { name: 'Stop the current turn', exact: true })
    .click();
  await expect(composer).toBeEditable();
  await page.reload();
  await expect(transcript).toContainText(
    'The approved receiver tool completed.',
  );
  await expect(composer).toBeEditable();
  const prepared = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/attachment-staging/prepare'),
  );
  const uploaded = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      /\/attachment-staging\/stage_/.test(response.url()),
  );
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach files', exact: true }).click();
  await (await chooser).setFiles({
    name: 'qualification.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Receiver attachment qualification.\n'.repeat(8192)),
  });
  expect((await prepared).ok()).toBe(true);
  const upload = await uploaded;
  expect(upload.ok()).toBe(true);
  expect(
    Boolean(await upload.request().headerValue(PEER_CHAT_UPLOAD_GRANT_HEADER)),
  ).toBe(true);
  expect(new URL(upload.url()).pathname).toContain('/chat-api/');
  await composer.fill('Read the staged qualification attachment.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => streams.length).toBe(4);
  streams[3]!.stream.text('The receiver accepted the attachment turn.');
  streams[3]!.stream.finish();
  await expect(transcript).toContainText(
    'The receiver accepted the attachment turn.',
  );
  const keyedSends: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname.endsWith('/api/orchestration/chat')
    ) {
      const body = request.postDataJSON() as { clientTurnId?: string };
      if (body.clientTurnId) keyedSends.push(body.clientTurnId);
    }
  });
  await page.evaluate(() =>
    window.stationConnectionFaults.disconnectEvents(true),
  );
  await page.evaluate(() => window.stationConnectionFaults.loseNextSend());
  await composer.fill(
    'Resolve this lost acknowledgement without a second turn.',
  );
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => streams.length).toBe(5);
  await expect(
    page.getByRole('button', { name: 'Check', exact: true }),
  ).toBeVisible();
  await captureConnectionState(page, testInfo, 'relay-uncertain');
  streams[4]!.stream.text('The uncertain send ran exactly once.');
  streams[4]!.stream.finish();
  await page.reload();
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(transcript).toContainText(
    'The uncertain send ran exactly once.',
  );
  await expect(
    page.getByRole('button', { name: 'Check', exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    window.stationConnectionFaults.disconnectEvents(false),
  );
  expect(keyedSends).toHaveLength(1);
  expect(new Set(keyedSends).size).toBe(1);
  expect(streams).toHaveLength(5);
  await composer.fill('Keep this draft when the preview is off.');
  await stationJson(
    source,
    '/api/feature-previews/paired-station-chats',
    'PUT',
    { enabled: false },
  );
  await page.reload();
  await expect(
    page.getByText('The approved receiver tool completed.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Keep this draft when the preview is off.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open Feature previews', exact: true }),
  ).toBeVisible();
  await expect(composer).toHaveCount(0);
  await captureConnectionState(page, testInfo, 'relay-preview-off');
  expect(streams).toHaveLength(5);
  await stationJson(
    source,
    '/api/feature-previews/paired-station-chats',
    'PUT',
    { enabled: true },
  );
  await page.reload();
  await expect(composer).toBeEditable();
  // Narrow the actual receiver grant, keeping its read authority for definite refusal.
  await stationJson(
    receiver,
    `/api/pairing/devices/${encodeURIComponent(stations.delegationDeviceId)}/scope`,
    'POST',
    { scope: ['orchestration:read'] },
  );
  await composer.fill('Keep this refused message editable.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript).toContainText(
    "Receiver didn't accept this message.",
  );
  await expect(transcript).not.toContainText('could not confirm');
  await expect(page.getByText(/insufficient_scope/)).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'Check', exact: true }),
  ).toHaveCount(0);
  await expect(composer).toBeEditable();
  await captureConnectionState(page, testInfo, 'relay-refused');
  const sourceAuthority = await page.request.get(
    `${source.ui}/api/auth/authority`,
  );
  expect(sourceAuthority.ok()).toBe(true);
  expect(await sourceAuthority.json()).toMatchObject({
    grant: { kind: 'device', deviceId: stations.sourceDeviceId },
  });
  expect(streams).toHaveLength(5);
  const refusedPreparation = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().endsWith('/attachment-staging/prepare'),
  );
  const refusedChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach files', exact: true }).click();
  await (await refusedChooser).setFiles({
    name: 'refused.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('This upload must be refused.\n'.repeat(8192)),
  });
  expect((await refusedPreparation).status()).toBe(424);
  await expect(
    page.getByText(/Upload failed|Upload didn't finish/, { exact: true }),
  ).toBeVisible();
  // Source revocation is a separate authority failure, never attributed to R.
  await stationJson(
    source,
    `/api/pairing/devices/${encodeURIComponent(stations.sourceDeviceId)}`,
    'DELETE',
  );
  const sourceRevoked = await page.request.get(
    `${source.ui}/api/auth/authority`,
  );
  expect(sourceRevoked.status()).toBe(401);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Connect to a Station', exact: true }),
  ).toBeVisible();
});
