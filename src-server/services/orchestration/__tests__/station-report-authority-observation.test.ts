import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { StationReportGroupRuntime } from '../station-report-group-runtime.js';
import { createReportFlow } from './delegation-source-fixtures/flow.js';
import { setup } from './delegation-source-fixtures/report.js';
import {
  fixture,
  selection,
  subject,
} from './delegation-source-fixtures/source.js';

test('a report roster observation shares one home hold and revalidates authority on the next read', async () => {
  const h = await setup();
  const handle = await h.owner.prepare(h.f.context(), h.input);
  const link = fs.linkSync;
  let holds = 0;
  const observe = vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    if (String(to) === join(h.f.home, 'security', '.home-writer.mutation'))
      holds++;
    return link(from, to);
  });
  syncBuiltinESMExports();
  try {
    const view = h.owner.read(handle, h.f.req);
    assert.equal(view.members.length, 2);
    assert.equal(holds, 1);
    h.f.environment.devicePairing.revokeDevice(
      h.f.paired.device.id,
      'operator-credential',
    );
    assert.throws(() => h.owner.read(handle, h.f.req), {
      code: 'group_preparation_unavailable',
    });
    assert.equal(h.rawFetch.mock.calls.length, 0);
  } finally {
    observe.mockRestore();
    syncBuiltinESMExports();
    h.owner.close(handle);
  }
});

test('the Flow source admission guard uses one home hold and refuses authority changed before the next check', async () => {
  const f = await fixture();
  const run = await createReportFlow(f, 'coherent-flow-check', [
    { id: 'left' },
  ]);
  const captured = await f.owner.captureSnapshot(
    f.context(),
    subject,
    selection,
  );
  const flow = await f.owner.prepareFlowSnapshot(
    f.context(),
    subject,
    captured.capability,
    run.runId,
  );
  const link = fs.linkSync;
  let holds = 0;
  const observe = vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    if (String(to) === join(f.home, 'security', '.home-writer.mutation'))
      holds++;
    return link(from, to);
  });
  syncBuiltinESMExports();
  try {
    flow.assertCurrent();
    assert.equal(holds, 1);
    f.environment.devicePairing.revokeDevice(
      f.paired.device.id,
      'operator-credential',
    );
    assert.throws(() => flow.assertCurrent(), {
      code: 'authorization_unavailable',
    });
  } finally {
    observe.mockRestore();
    syncBuiltinESMExports();
    f.owner.releaseSnapshot(captured.capability);
  }
});

test('the response authorizer shares one home hold and refuses revocation on the next call', async () => {
  const h = await setup();
  const eventStore = new EventStore(join(h.f.root, 'authorization.sqlite'));
  const orchestration = new OrchestrationService({
    eventBus: new EventBus(),
    eventStore,
    adapterRegistry: createGateTestRegistry(new GateTestAdapter()),
    logger: { debug() {}, warn() {} },
  });
  const runtime = new StationReportGroupRuntime({
    runtime: h.preparationOwners.runtime,
    orchestration,
    rawFetch: h.rawFetch,
  });
  const current = await runtime.authorizeResponse(h.f.context());
  const link = fs.linkSync;
  let holds = 0;
  const observe = vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    if (String(to) === join(h.f.home, 'security', '.home-writer.mutation'))
      holds++;
    return link(from, to);
  });
  syncBuiltinESMExports();
  try {
    current();
    assert.equal(holds, 1);
    h.f.environment.devicePairing.revokeDevice(
      h.f.paired.device.id,
      'operator-credential',
    );
    assert.throws(current, { code: 'authorization_unavailable' });
    assert.equal(h.rawFetch.mock.calls.length, 0);
  } finally {
    observe.mockRestore();
    syncBuiltinESMExports();
    await orchestration.shutdown();
    eventStore.close();
  }
});
