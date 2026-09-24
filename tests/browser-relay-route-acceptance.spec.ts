import { expect, type Page } from '@playwright/test';
import { test } from './helpers/fixture-audit';

const STATION_ID = '11111111-1111-4111-8111-111111111111';
const ENROLLMENT_ID = '22222222-2222-4222-8222-222222222222';

async function prepareComputerPage(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('station:onboarding-setup-dismissed', '1');
  });
}

test('browser route acceptance requires independently approved Station identity', async ({
  page,
}) => {
  await prepareComputerPage(page);
  await page.goto('/connections/computers');
  await expect(
    page.getByRole('heading', { name: 'Computers', level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Broker routes' }),
  ).toBeVisible();

  const applicationOrigin = 'https://station.route-test.invalid';
  const browserOrigin = new URL(page.url()).origin;
  const invitation = {
    version: 'station-broker-route-invitation/v1',
    brokerOrigin: 'https://broker.route-test.invalid',
    scope: {
      stationId: STATION_ID,
      enrollmentId: ENROLLMENT_ID,
      routingGeneration: 1,
      browserOrigin,
    },
    stationSigningKeyId: 'A'.repeat(43),
    stationSigningGeneration: 1,
    invitationId: 'local-test-invitation',
    invitationSecret: 'B'.repeat(43),
    expiresAt: Date.now() + 60_000,
  };
  const directStationRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).origin === applicationOrigin)
      directStationRequests.push(request.url());
  });

  await page.getByLabel('Station name').fill('Local relay Station');
  await page.getByLabel('Station application address').fill(applicationOrigin);
  await page
    .getByLabel('Broker invitation link or private JSON')
    .fill(JSON.stringify(invitation));
  await page.getByRole('button', { name: 'Accept route' }).click();

  await expect(page.locator('.connections-computers__alert')).toContainText(
    'Approve this Station’s signing key independently before accepting its broker invitation.',
  );
  await expect(
    page.getByText('Local relay Station', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Connect', exact: true }),
  ).toHaveCount(0);
  expect(directStationRequests).toEqual([]);
});
