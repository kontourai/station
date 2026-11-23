import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CliSessionGroupListPage,
  CliSessionGroupView,
} from '@kontourai/station-contracts/delegation-group';
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
  let checkCurrent = (_request: Request) => {};
  const delegateTask = vi.fn();
  const app = createOrchestrationRoutes(service, {
    cliSessionGroups: { home, preview },
    eventBus,
    logger,
    getUserId: () => 'owner',
    callerBindingForRequest: (request) =>
      request.headers.get('fixture-credential') ?? undefined,
    isRequestPrincipalCurrent: (request) => {
      checkCurrent(request);
      return current;
    },
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
  const create = (
    operationId = body.operationId,
    credential = 'credential-one',
  ) =>
    app.request('/session-groups', {
      method: 'POST',
      headers: { 'fixture-credential': credential },
      body: JSON.stringify({ ...body, operationId }),
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
    setCurrentCheck: (check: typeof checkCurrent) => {
      checkCurrent = check;
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

test('group listing pages only the current credential’s retained groups', async () => {
  const f = fixture();
  const list = (suffix = '') =>
    f.app.request(`/session-groups${suffix}`, {
      headers: { 'fixture-credential': 'credential-one' },
    });
  expect((await list()).status).toBe(404);
  await f.setPreview(true);

  const create = async (operationId: string, credential?: string) => {
    const response = await f.create(operationId, credential);
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: CliSessionGroupView };
    return data.groupId;
  };
  const foreign = await create('foreign', 'credential-two');
  const owned = [];
  for (let index = 0; index < 17; index += 1)
    owned.push(await create(`operation-${index}`));
  owned.sort();

  const readPage = async (suffix = '') => {
    const response = await list(suffix);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const text = await response.text();
    expect(text).not.toContain(foreign);
    expect(text).not.toContain(f.body.members[0].prompt);
    return (JSON.parse(text) as { data: CliSessionGroupListPage }).data;
  };
  const first = await readPage();
  expect(first.groups.map((group) => group.groupId)).toEqual(
    owned.slice(0, 16),
  );
  expect(first).toMatchObject({ hasMore: true, nextGroupId: owned[15] });
  const last = await readPage(`?afterGroupId=${first.nextGroupId}`);
  expect(last.groups.map((group) => group.groupId)).toEqual(owned.slice(16));
  expect(last).toMatchObject({ hasMore: false, nextGroupId: null });
  expect((await list('?afterGroupId=%2F..')).status).toBe(400);
  f.revoke();
  expect((await list()).status).toBe(403);
  expect(f.delegateTask).not.toHaveBeenCalled();
});

test('revoking the credential at cancellation publication leaves the prior group record', async () => {
  const f = fixture();
  await f.setPreview(true);
  const created = await f.create();
  expect(created.status).toBe(200);
  const { data } = (await created.json()) as { data: CliSessionGroupView };
  let sawStagedCancellation = false;
  f.setCurrentCheck((request) => {
    if (!new URL(request.url).pathname.endsWith('/cancel')) return;
    const staged = readdirSync(f.root).find(
      (name) =>
        name.startsWith(`${data.groupId}.json.`) && name.endsWith('.tmp'),
    );
    if (!staged) return;
    expect(
      JSON.parse(readFileSync(join(f.root, staged), 'utf8')),
    ).toMatchObject({
      cancelled: true,
    });
    sawStagedCancellation = true;
    f.revoke();
  });

  const response = await f.app.request(
    `/session-groups/${data.groupId}/cancel`,
    {
      method: 'POST',
      headers: { 'fixture-credential': 'credential-one' },
    },
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    code: 'group_authority_required',
  });
  expect(sawStagedCancellation).toBe(true);
  const record = JSON.parse(
    readFileSync(join(f.root, `${data.groupId}.json`), 'utf8'),
  );
  expect(record).toMatchObject({ cancelled: false, revision: data.revision });
  expect(readdirSync(f.root).filter((name) => name.endsWith('.tmp'))).toEqual(
    [],
  );
});
