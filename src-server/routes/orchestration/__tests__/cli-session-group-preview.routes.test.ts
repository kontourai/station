import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CliSessionGroupView } from '@kontourai/station-contracts/delegation-group';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FeaturePreviewRegistry } from '../../../services/feature-previews/feature-preview-registry.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const temporary = trackTempDirs();
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fixture() {
  const home = temporary('station-cli-group-preview-');
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    setLevel: vi.fn(),
    getLevel: vi.fn(() => 'info' as const),
  };
  const registry = new FeaturePreviewRegistry(home, logger);
  const preview = registry.bind({
    id: 'cli-session-groups',
    label: 'Session groups',
    description: 'Create and inspect Session groups.',
  });
  const eventBus = new EventBus();
  const service = new OrchestrationService({
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    eventBus,
    logger,
  });
  cleanups.push(async () => {
    await service.shutdown();
  });
  let current = true;
  const delegateTask = vi.fn();
  const app = createOrchestrationRoutes(service, {
    cliSessionGroups: { home, preview },
    eventBus,
    logger,
    getUserId: () => 'owner',
    callerBindingForRequest: (request) =>
      request.headers.get('fixture-credential') ?? undefined,
    isRequestPrincipalCurrent: () => current,
    delegateTask,
  });
  const body = {
    operationId: 'create-one',
    members: [
      {
        seatId: 'first',
        prompt: 'Private Task brief',
        target: {
          agent: 'reviewer',
          expectedEngine: { kind: 'connection', connectionId: 'claude' },
        },
      },
    ],
    maxConcurrent: 1,
    maxDispatches: 0,
    deadlineAt: Date.now() + 60_000,
  };
  const root = join(home, 'runtime', 'cli-session-groups');
  const create = () =>
    app.request('/session-groups', {
      method: 'POST',
      headers: { 'fixture-credential': 'credential-one' },
      body: JSON.stringify(body),
    });

  return {
    app,
    body,
    create,
    delegateTask,
    root,
    setPreview: (enabled: boolean) =>
      registry.setEnabled('cli-session-groups', enabled),
    revoke: () => {
      current = false;
    },
  };
}

test('the live preview gates durable group creation and keeps reads bound to the creating credential', async () => {
  const f = fixture();
  expect((await f.create()).status).toBe(404);
  expect(existsSync(f.root)).toBe(false);

  await f.setPreview(true);
  const created = await f.create();
  expect(created.status).toBe(200);
  const { data } = (await created.json()) as { data: CliSessionGroupView };
  expect(data).toMatchObject({
    maxDispatches: 0,
    dispatchCount: 0,
    admissionClosed: 'dispatch-limit-exhausted',
  });
  expect(await (await f.create()).json()).toMatchObject({
    data: { groupId: data.groupId, revision: data.revision },
  });
  const path = `/session-groups/${data.groupId}`;
  const read = async (credential: string) =>
    f.app.request(path, { headers: { 'fixture-credential': credential } });
  const owned = await read('credential-one');
  expect(owned.status).toBe(200);
  expect(await owned.text()).not.toContain(f.body.members[0].prompt);
  expect((await read('credential-two')).status).toBe(404);

  await f.setPreview(false);
  expect((await read('credential-one')).status).toBe(404);
  expect(f.delegateTask).not.toHaveBeenCalled();
});

test('revoking the creating credential during body collection refuses the durable write', async () => {
  const f = fixture();
  await f.setPreview(true);
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        f.revoke();
        controller.enqueue(new TextEncoder().encode(JSON.stringify(f.body)));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const init = {
    method: 'POST',
    headers: { 'fixture-credential': 'credential-one' },
    body,
    duplex: 'half',
  } satisfies RequestInit;
  const response = await f.app.request('/session-groups', init);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: 'group_authority_required',
  });
  expect(existsSync(f.root)).toBe(true);
  expect(readdirSync(f.root).filter((name) => name.endsWith('.json'))).toEqual(
    [],
  );
  expect(f.delegateTask).not.toHaveBeenCalled();
});
