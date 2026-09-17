/** Real owner/runtime/browser proof. Only the managed runner's disposable home is seeded. */
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { getOrchestrationDatabasePath } from '../src-server/domain/migrations/003-orchestration-events';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../src-server/services/identity/principal-resolver';
import { EventStore } from '../src-server/services/orchestration/event-store';
import { expect, test } from './helpers/authenticated-request';

function runnerOwnedHome(): string {
  const home = process.env.STATION_E2E_HOME;
  const ui = process.env.STATION_E2E_UI_DIR;
  if (
    process.env.STATION_E2E_RUNNER !== '1' ||
    !home ||
    !isAbsolute(home) ||
    !ui ||
    !isAbsolute(ui)
  )
    throw new Error(
      'Exact search proof requires the managed runner-owned disposable home.',
    );
  const instance = basename(ui).replace(/^dist-ui-/, '');
  if (
    !/^e2e-product-\d+-[a-z0-9]+$/.test(instance) ||
    realpathSync(dirname(ui)) !== realpathSync(process.cwd())
  )
    throw new Error('Exact search proof refused an unowned runner instance.');
  const recordPath = join(
    process.cwd(),
    '.station',
    'instances',
    `${instance}.json`,
  );
  const stat = lstatSync(recordPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
    throw new Error(
      'Exact search proof requires a bounded launcher registry record.',
    );
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  if (
    record.homeSource !== '--temp-home' ||
    record.instanceId !== instance ||
    realpathSync(record.cwd) !== realpathSync(process.cwd()) ||
    realpathSync(record.baseDir) !== realpathSync(home) ||
    record.uiPort !== Number(new URL(process.env.PW_BASE_URL ?? '').port)
  )
    throw new Error(
      'Exact search proof refused a home not attested by this runner launch.',
    );
  return realpathSync(home);
}

test('keyboard search reveals historical A canonical event despite current child B and pages its text', async ({
  page,
}) => {
  const home = runnerOwnedHome();
  const store = new EventStore(getOrchestrationDatabasePath(home));
  const a = `search-a-${randomUUID()}`;
  const b = `search-b-${randomUUID()}`;
  const needle = `heliotrope${randomUUID().replaceAll('-', '')}`;
  const prefix = `Historical A canonical ${needle}. `;
  const body =
    prefix +
    'a'.repeat(4096 - prefix.length) +
    'Second canonical text page from historical A.';
  const seed = (threadId: string, content: string, createdAt: string) => {
    store.upsertSession({
      provider: 'claude',
      threadId,
      status: 'ready',
      controlMode: 'read-only-attached',
      createdAt,
      updatedAt: createdAt,
    });
    store.appendEvent({
      eventId: `${threadId}:start`,
      threadId,
      sessionId: threadId,
      provider: 'claude',
      createdAt,
      method: 'session.started',
      metadata: {
        userId: LOCAL_OPERATOR_PRINCIPAL_ID,
        agentSlug: 'retired-search-agent',
      },
    });
    store.appendEvent({
      eventId: `${threadId}:exact`,
      threadId,
      turnId: `${threadId}:turn`,
      provider: 'claude',
      createdAt,
      method: 'turn.started',
      prompt: content,
    });
  };
  try {
    seed(a, body, '2026-09-03T00:00:00.000Z');
    store.reserveNextConversationSession({
      conversationId: a,
      predecessorSessionId: a,
      proposedSessionId: b,
      createdAt: '2026-09-04T00:00:00.000Z',
    });
    seed(
      b,
      `Current B different message ${needle}`,
      '2026-09-04T00:00:00.000Z',
    );
    for (let index = 0; index < 25; index++)
      store.appendEvent({
        eventId: `${a}:later-${index}`,
        threadId: a,
        turnId: `${a}:later-turn-${index}`,
        provider: 'claude',
        method: 'turn.started',
        createdAt: new Date(Date.UTC(2026, 8, 3, 1, index)).toISOString(),
        prompt: `Later unrelated message ${index}`,
      });
    expect(store.conversationSessions(a).at(-1)?.sessionId).toBe(b);
    expect(
      store
        .listEventWindowByTurn(a, { turnLimit: 10 })
        .events.some((entry) => entry.payload.eventId === `${a}:exact`),
    ).toBe(false);
    await page.goto('/');
    await expect(async () => {
      await page.evaluate(() =>
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'k',
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      await expect(
        page.getByRole('dialog', { name: 'Command palette', exact: true }),
      ).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 15000 });
    await page
      .getByRole('button', {
        name: 'Workspace search (this Station)',
        exact: true,
      })
      .click();
    const legacyReads: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/conversations/search')
        legacyReads.push(request.url());
    });
    const input = page.getByRole('combobox', {
      name: "Search this Station's work",
    });
    await expect(input).toBeFocused();
    await input.fill(needle);
    const historical = page
      .getByRole('option')
      .filter({ hasText: `Historical A canonical ${needle}` });
    await expect(historical).toBeVisible();
    const id = await historical.getAttribute('id');
    if (!id || !/^workspace-result-\d+$/.test(id))
      throw new Error('Missing keyboard result identity');
    const index = Number(id.slice('workspace-result-'.length));
    expect(index).toBeLessThan(16);
    for (let step = 0; step < index; step++) await input.press('ArrowDown');
    await expect(input).toHaveAttribute('aria-activedescendant', id);
    await input.press('Enter');
    const inspector = page.getByRole('dialog', {
      name: 'Matched message — read-only',
    });
    await expect(inspector).toBeVisible();
    const exact = inspector.getByRole('region', {
      name: 'Exact matched message',
    });
    await expect(exact).toHaveAttribute('data-search-event-id', `${a}:exact`);
    await expect(exact).toContainText(prefix.trim());
    await expect(exact).toBeFocused();
    await expect(inspector).not.toContainText('Current B different message');
    await expect(inspector).toContainText('Agent: retired-search-agent');
    await inspector.getByRole('button', { name: 'Next text page' }).click();
    await expect(exact).toContainText(
      'Second canonical text page from historical A.',
    );
    await expect(inspector).not.toContainText(prefix.trim());
    expect(legacyReads).toEqual([]);
    await inspector
      .getByRole('button', { name: 'Close matched message' })
      .click();
    await expect(inspector).toHaveCount(0);
  } finally {
    store.deleteThread(b);
    store.deleteThread(a);
    await expect.poll(() => store.close().kind).toBe('closed');
  }
});
