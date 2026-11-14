/**
 * Service rules that hold for every binding: capability flags are enforced
 * (an off flag refuses before any request, an undeclared usage unit is
 * dropped), and removing a connection while one of its syncs is in flight
 * leaves no task behind.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { devinBinding } from '../bindings/devin.js';
import { REMOTE_TASK_BINDINGS } from '../bindings/index.js';
import { RemoteTaskStore } from '../stores.js';
import { harness } from './harness.js';
import { devinFake } from './vendor-fakes.js';

const ORG = 'org-abc123def456';
const TOKEN = 'cog_test_token_devin_0001';

function withDevin(overrides: Partial<typeof devinBinding>) {
  return { ...REMOTE_TASK_BINDINGS, devin: { ...devinBinding, ...overrides } };
}

describe('remote task service', () => {
  test('an operation whose capability flag is off is refused before any request', async () => {
    const devin = devinFake(ORG);
    const h = harness(
      devin.fake.fetch,
      undefined,
      withDevin({
        capabilities: {
          ...devinBinding.capabilities,
          getTask: false,
          listTasks: false,
        },
      }),
    );
    const id = await h.readyConnection('devin', TOKEN, { orgId: ORG });
    await expect(
      h.service.getTask(id, 'devin-000000000001'),
    ).rejects.toMatchObject({
      code: 'remote-task-capability-unsupported',
    });
    await expect(h.service.listTasks(id, null)).rejects.toMatchObject({
      code: 'remote-task-capability-unsupported',
    });
    await expect(
      h.service.syncTask(id, 'devin-000000000001'),
    ).rejects.toMatchObject({
      code: 'remote-task-capability-unsupported',
    });
    expect(devin.fake.requests).toHaveLength(0);
  });

  test('usage in a unit the binding does not declare is dropped', async () => {
    const devin = devinFake(ORG);
    const h = harness(
      devin.fake.fetch,
      undefined,
      withDevin({
        capabilities: { ...devinBinding.capabilities, usageUnits: ['acu'] },
      }),
    );
    const id = await h.readyConnection('devin', TOKEN, { orgId: ORG });
    const { taskId } = await h.service.createTask(id, { prompt: 'Go' });
    Object.assign(devin.sessions.get(taskId) as object, {
      acus_consumed: 2,
      on_demand_usage: 4.5,
    });
    const task = await h.service.getTask(id, taskId);
    expect(task.usage).toEqual([{ unit: 'acu', quantity: 2 }]);
  });

  test('removing a connection while its sync is in flight leaves no task file', async () => {
    const devin = devinFake(ORG);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hold = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (hold && String(input).includes('/messages')) await held;
      return devin.fake.fetch(input, init);
    };
    const h = harness(fetchImpl);
    const id = await h.readyConnection('devin', TOKEN, { orgId: ORG });
    const { taskId } = await h.service.createTask(id, { prompt: 'Go' });
    devin.setStatus(taskId, 'running', 'working');
    hold = true;
    const sync = h.service
      .syncTask(id, taskId)
      .catch((error: unknown) => error);
    // Let the sync reach the held messages request, then remove the connection.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await h.service.deleteConnection(id);
    release();
    expect(await sync).toMatchObject({ code: 'remote-task-not-found' });
    const dir = join(h.home, 'remote-task-engines', 'tasks', id);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    expect(new RemoteTaskStore(h.home).hasTasks(id)).toBe(false);
  });
});
