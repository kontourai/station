import { expect } from '@playwright/test';
import {
  addDirectReceiver,
  captureConnectionState,
  startConnectionChat,
  stationJson,
  test,
} from './helpers/peer-chat-stations';

test.use({ hostModel: true });
test.setTimeout(600_000);

test('host and peer dock adopt the same writable conversation controls', async ({
  page,
  stations,
}, testInfo) => {
  test.setTimeout(600_000);
  const { streams } = stations;
  await startConnectionChat(page, 'host', 'Check the local project.');
  const transcript = page.getByRole('log', { name: 'Conversation transcript' });
  await expect.poll(() => streams.length).toBe(1);
  expect(streams[0]!.station).toBe('source');
  streams[0]!.stream.text('Local text arrives while the provider is running.');
  await expect(transcript).toContainText(
    'Local text arrives while the provider is running.',
  );
  await captureConnectionState(page, testInfo, 'host-streaming');
  expect(streams[0]!.offeredTools).toContain(
    'stationDocs_listStationDocsTopics',
  );
  streams[0]!.stream.tool(
    'stationDocs_listStationDocsTopics',
    {},
    'host-topics',
  );
  streams[0]!.stream.finish('tool_calls');
  await page.getByRole('button', { name: '1 pending approval' }).click();
  await captureConnectionState(page, testInfo, 'host-approval');
  await page.getByRole('button', { name: 'Allow Once', exact: true }).click();
  await expect.poll(() => streams.length).toBe(2);
  streams[1]!.stream.text('Local approval completed.');
  streams[1]!.stream.finish();
  await expect(transcript).toContainText('Local approval completed.');
  await expect(page.getByPlaceholder(/^Type a message/)).toBeEditable();
  await captureConnectionState(page, testInfo, 'host-idle');
  const localDraft = 'Keep the local draft while receiver events arrive.';
  await page.getByPlaceholder(/^Type a message/).fill(localDraft);
  await startConnectionChat(
    page,
    'relay',
    'Use the receiver with the same composer.',
  );
  await expect.poll(() => streams.length).toBe(3);
  expect(streams[2]!.station).toBe('receiver');
  streams[2]!.stream.text('Receiver uses the shared conversation body.');
  streams[2]!.stream.finish();
  await expect(transcript).toContainText(
    'Receiver uses the shared conversation body.',
  );
  await expect(page.getByPlaceholder(/^Type a message/)).toBeEditable();
  await expect(page.getByText('Via Receiver', { exact: true })).toBeVisible();
  const paired = await addDirectReceiver(page, stations.receiver);
  const composer = page.getByPlaceholder(/^Type a message/);
  const stillRelayed = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      new URL(request.url()).pathname.includes(
        '/chat-api/api/orchestration/chat',
      ),
  );
  await composer.fill('Keep the existing relay principal.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await stillRelayed;
  await expect.poll(() => streams.length).toBe(4);
  streams[3]!.stream.text('Existing chat stayed on its relay.');
  streams[3]!.stream.finish();
  await expect(transcript).toContainText('Existing chat stayed on its relay.');
  const directRequest = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      request.url() === `${stations.receiver.api}/api/orchestration/chat`,
  );
  await startConnectionChat(
    page,
    'relay',
    'Prefer the independently paired direct route.',
  );
  const direct = await directRequest;
  // Reduce credential comparison to a boolean so assertion output cannot disclose it.
  expect(
    (await direct.headerValue('authorization')) ===
      `Bearer ${paired.credential}`,
  ).toBe(true);
  await expect.poll(() => streams.length).toBe(5);
  streams[4]!.stream.text('The new chat uses the direct receiver Device.');
  await expect(transcript).toContainText(
    'The new chat uses the direct receiver Device.',
  );
  await expect(
    page.getByText('Via Direct Receiver', { exact: true }),
  ).toBeVisible();
  await captureConnectionState(page, testInfo, 'direct-streaming');
  streams[4]!.stream.finish();
  await expect(composer).toBeEditable();
  await captureConnectionState(page, testInfo, 'direct-idle');
  await page.getByRole('button', { name: /^Show inbox/ }).click();
  await page
    .getByRole('complementary', { name: 'Inbox chats' })
    .getByRole('button', { name: /Check the local project/ })
    .click();
  await expect(transcript).toContainText('Local approval completed.');
  await expect(transcript).not.toContainText(
    'The new chat uses the direct receiver Device.',
  );
  await expect(composer).toHaveValue(localDraft);
  await page.evaluate(() =>
    window.stationConnectionFaults.disconnectEvents(true),
  );
  await page.evaluate(() => window.stationConnectionFaults.loseNextSend());
  await composer.fill('Check this local lost acknowledgement.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => streams.length).toBe(6);
  await expect(
    page.getByRole('button', { name: 'Check', exact: true }),
  ).toBeVisible();
  await captureConnectionState(page, testInfo, 'host-uncertain');
  streams[5]!.stream.text('The local uncertain turn ran once.');
  streams[5]!.stream.finish();
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Check', exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() =>
    window.stationConnectionFaults.disconnectEvents(false),
  );
  await expect(transcript).toContainText('The local uncertain turn ran once.');
  await stationJson(
    stations.source,
    `/api/pairing/devices/${encodeURIComponent(stations.sourceDeviceId)}/scope`,
    'POST',
    { scope: ['orchestration:read'] },
  );
  await composer.fill('Keep this local refused message editable.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript).toContainText("didn't accept this message.");
  await expect(composer).toBeEditable();
  await captureConnectionState(page, testInfo, 'host-refused');
  expect(streams).toHaveLength(6);
});
