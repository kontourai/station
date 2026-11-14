import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { onTestFinished, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { ProviderCredentialObservationStore } from '../../../runtime/conversation/provider-credential-observation.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import {
  ProjectBindingsStore,
  projectBindingStorePath,
} from '../../projects/project-binding-store.js';
import { projectManifestPath } from '../../projects/project-manifest-store.js';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import {
  type HomeWriterLease,
  HomeWriterOwner,
} from '../../ssh/home-writer-owner.js';
import { LocalSourceAdmissionOwner } from '../delegation-group-source-admission.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { StationReportGroupPreparation } from '../station-report-group-preparation.js';
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

test('a prepared report remains readable before its deadline and refuses at the exact deadline', async () => {
  const h = await setup();
  const handle = await h.owner.prepare(h.f.context(), h.input);
  try {
    vi.mocked(Date.now).mockReturnValue(h.input.deadlineAt - 1);
    assert.equal(h.owner.read(handle, h.f.req).members.length, 2);
    vi.mocked(Date.now).mockReturnValue(h.input.deadlineAt);
    assert.throws(() => h.owner.read(handle, h.f.req), {
      code: 'group_preparation_unavailable',
    });
    assert.equal(h.rawFetch.mock.calls.length, 0);
  } finally {
    h.owner.close(handle);
  }
});

test('the Flow source admission guard uses one home hold and refuses authority changed before the next check', async () => {
  const f = await fixture();
  f.owner = new LocalSourceAdmissionOwner(
    f.home,
    f.environment,
    f.store,
    undefined,
    f.environment.canonicalLocalGrantOrigin(),
  );
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
  const open = fs.openSync;
  let tokenOpens = 0;
  const openObserver = vi
    .spyOn(fs, 'openSync')
    .mockImplementation((...args) => {
      if (String(args[0]).includes('.home-writer.mutation')) tokenOpens++;
      return open(...args);
    });
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
    assert.ok(tokenOpens > 0, 'observe the real Home inspection path');
    assert.ok(
      tokenOpens <= 46,
      `source Flow guard inspected Home ${tokenOpens} times; fallback baseline was 47`,
    );
    assert.equal(holds, 1);
    f.environment.devicePairing.revokeDevice(
      f.paired.device.id,
      'operator-credential',
    );
    assert.throws(() => flow.assertCurrent(), {
      code: 'authorization_unavailable',
    });
  } finally {
    openObserver.mockRestore();
    observe.mockRestore();
    syncBuiltinESMExports();
    f.owner.releaseSnapshot(captured.capability);
  }
});

test.each(['GET', 'POST'] as const)(
  'source request authority rejects a foreign canonical owner for %s',
  async (method) => {
    const f = await fixture();
    const principal = getRuntimeAuthenticatedRequestPrincipal(f.req);
    assert.ok(principal?.kind === 'credential');
    const request = new Request(
      `http://127.0.0.1:43979/api/orchestration/${method === 'GET' ? 'sessions' : 'chat'}`,
      { method },
    );
    setRuntimeAuthenticatedRequestPrincipal(request, principal);
    bindRuntimeLocalOperator(request);
    const owner = new LocalSourceAdmissionOwner(
      f.home,
      f.environment,
      f.store,
      undefined,
      f.environment.canonicalLocalGrantOrigin(),
    );
    const authority = await owner.captureRequestAuthority(f.context(request));
    const otherEnvironment = new EnvironmentSecurityService({
      homeDir: f.home,
    });
    await otherEnvironment.initialize();
    const foreign = new LocalSourceAdmissionOwner(
      f.home,
      f.environment,
      f.store,
      undefined,
      otherEnvironment.canonicalLocalGrantOrigin(),
    );
    assert.doesNotThrow(authority.assertCurrent);
    await assert.rejects(foreign.captureRequestAuthority(f.context(request)), {
      code: 'authorization_unavailable',
    });
    assert.doesNotThrow(authority.assertCurrent);
  },
);

test('the response authorizer shares one home hold and refuses revocation on the next call', async () => {
  const h = await setup();
  const eventStore = new EventStore(join(h.f.root, 'authorization.sqlite'));
  const orchestration = new OrchestrationService({
    eventBus: new EventBus(),
    eventStore,
    adapterRegistry: createGateTestRegistry(new GateTestAdapter()),
    logger: { debug() {}, warn() {} },
  });
  onTestFinished(async () => {
    await orchestration.shutdown();
    eventStore.close();
  });
  const runtime = new StationReportGroupRuntime({
    runtime: h.preparationOwners.runtime,
    orchestration,
    rawFetch: h.rawFetch,
  });
  const writer = await HomeWriterOwner.forHome(h.f.home);
  const runOwnedLease = HomeWriterOwner.prototype.runOwnedLease;
  let competing: HomeWriterLease | undefined;
  let releaseTimer: ReturnType<typeof setImmediate> | undefined;
  let competingReleased = false;
  let releaseCompeting: Promise<void> | undefined;
  const retirement = vi
    .spyOn(HomeWriterOwner.prototype, 'runOwnedLease')
    .mockImplementationOnce(async function <Value>(
      this: HomeWriterOwner,
      signal: AbortSignal,
      body: (lease: HomeWriterLease) => Promise<Value>,
    ): Promise<Value> {
      const value = await (runOwnedLease<Value>).call(this, signal, body);
      const other = await writer.acquire(signal);
      competing = other;
      releaseCompeting = new Promise<void>((resolve, reject) => {
        releaseTimer = setImmediate(() => {
          void other.release().then(() => {
            competingReleased = true;
            resolve();
          }, reject);
        });
      });
      void releaseCompeting.catch(() => {});
      return value;
    });
  let current: Awaited<ReturnType<typeof runtime.authorizeResponse>>;
  try {
    current = await runtime.authorizeResponse(h.f.context());
    assert.ok(
      competing,
      'a real second Home owner must enter after capture retirement',
    );
    assert.equal(
      competingReleased,
      true,
      'response capture must wait for the competing Home owner',
    );
    await releaseCompeting;
  } finally {
    retirement.mockRestore();
    if (releaseTimer) clearImmediate(releaseTimer);
    await competing?.release();
  }
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
  }
});

test.each(['credential', 'project', 'manifest', 'bindings', 'layout'] as const)(
  'canonical two-Agent Flow roster reads retain live authority with bounded Home inspections: %s',
  async (revocation) => {
    const h = await setup();
    if (revocation === 'bindings') {
      const bindings = new ProjectBindingsStore(h.f.home);
      fs.writeFileSync(bindings.path, JSON.stringify(bindings.read()), {
        mode: 0o600,
      });
    }
    await h.f.loader.saveAgent('reviewer-two', {
      name: 'Second reviewer',
      prompt: 'Configured second report instructions',
      execution: {
        modelConnectionId: 'anthropic-1',
        modelId: 'claude-sonnet-4-6',
      },
    });
    const flow = await createReportFlow(h.f, 'canonical-raw-prefix-cost', [
      { id: 'left' },
      { id: 'right' },
    ]);
    const owner = new StationReportGroupPreparation({
      ...h.preparationOwners,
      runtime: {
        ...h.preparationOwners.runtime,
        canonicalLocalGrantOrigin: h.f.environment.canonicalLocalGrantOrigin(),
      },
    });
    const credentials = new Set<object>();
    const capture =
      ProviderCredentialObservationStore.prototype.captureSdkCredential;
    const captured = vi
      .spyOn(
        ProviderCredentialObservationStore.prototype,
        'captureSdkCredential',
      )
      .mockImplementation(function (
        this: ProviderCredentialObservationStore,
        ...args
      ) {
        const credential = capture.apply(this, args);
        credentials.add(credential);
        return credential;
      });
    const handle = await owner.prepare(h.f.context(), {
      ...h.input,
      flow,
      members: [
        h.input.members[0],
        { ...h.input.members[1], agentId: 'reviewer-two' },
      ],
    });
    const projectPath = join(
      h.f.home,
      'projects',
      selection.projectSlug,
      'project.json',
    );
    const read = fs.readFileSync;
    let projectReads = 0;
    const projectRead = vi
      .spyOn(fs, 'readFileSync')
      .mockImplementation((...args) => {
        if (String(args[0]) === projectPath) projectReads++;
        return read(...args);
      });
    const open = fs.openSync;
    let opens = 0;
    const opened = vi
      .spyOn(fs, 'openSync')
      .mockImplementation((path, flags, mode) => {
        if (
          String(path) === join(h.f.home, 'security', '.home-writer.mutation')
        )
          opens++;
        return open(path, flags, mode);
      });
    syncBuiltinESMExports();
    try {
      assert.equal(credentials.size, 2);
      const view = owner.read(handle, h.f.req);
      assert.deepEqual(
        view.members.map((member) => member.agentId),
        ['reviewer', 'reviewer-two'],
      );

      assert.ok(projectReads > 0, 'the observer must see real Project reads');
      assert.ok(
        projectReads <= 2,
        `Project record read ${projectReads} times for two source members; maximum 2`,
      );
      assert.ok(opens > 0, 'the observer must see real Home inspections');
      assert.ok(
        opens <= 153,
        `Home inspections: ${opens}; remeasure the unfused owner before changing this bound`,
      );
      if (revocation === 'credential') {
        h.f.environment.devicePairing.revokeDevice(
          h.f.paired.device.id,
          'operator-credential',
        );
        assert.throws(() => owner.read(handle, h.f.req), {
          code: 'group_preparation_unavailable',
        });
      } else if (revocation === 'project') {
        fs.writeFileSync(projectPath, read(projectPath));
        assert.throws(
          () => owner.read(handle, h.f.req),
          /Project changed before preparation spawn/,
        );
      } else if (revocation === 'layout') {
        const at = new Date(Date.now()).toISOString();
        await h.f.storage.createLayout(selection.projectSlug, {
          id: 'added-layout',
          projectSlug: selection.projectSlug,
          type: 'chat',
          name: 'Added layout',
          slug: 'added-layout',
          config: {},
          createdAt: at,
          updatedAt: at,
        });
        assert.throws(() => owner.read(handle, h.f.req), {
          code: 'source_changed',
        });
      } else {
        const path =
          revocation === 'manifest'
            ? projectManifestPath(h.f.home, selection.projectSlug)
            : projectBindingStorePath(h.f.home);
        fs.writeFileSync(path, read(path));
        assert.throws(() => owner.read(handle, h.f.req), {
          code: 'source_changed',
        });
      }
      assert.equal(h.rawFetch.mock.calls.length, 0);
    } finally {
      opened.mockRestore();
      projectRead.mockRestore();
      captured.mockRestore();
      syncBuiltinESMExports();
      owner.close(handle);
    }
  },
);
