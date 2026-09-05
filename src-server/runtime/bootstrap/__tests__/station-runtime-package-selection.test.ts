import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { EventStore } from '../../../services/orchestration/event-store';
import type {
  PackageMcpAdmissionJournal,
  PackageMcpInstallation,
} from '../../../services/plugins/package-mcp-admission';
import {
  loadStablePreToolPolicySpec,
  StationRuntime,
} from '../station-runtime';

const digest = `sha256:${'a'.repeat(64)}`;
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function sharedHome() {
  const home = mkdtempSync(join(tmpdir(), 'station-selected-fingerprint-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, 'events.sqlite');
  const first = new EventStore(path),
    second = new EventStore(path);
  cleanups.push(
    () => first.close(),
    () => second.close(),
  );
  const agentPath = join(home, 'agent.json');
  writeFileSync(
    agentPath,
    JSON.stringify({
      name: 'Unchanged agent',
      prompt: 'Keep the same role.',
      model: 'fixture-model',
    }),
  );
  return { path, agentPath, first, second };
}
function select(
  journal: PackageMcpAdmissionJournal,
  previous: PackageMcpInstallation | null = null,
) {
  const selected = journal.recordInstallation({
    pluginId: 'fingerprint-fixture',
    contentDigest: digest,
    previous,
  });
  if (selected.state !== 'recorded')
    throw new Error(`Fixture selection failed: ${selected.state}`);
  return selected.installation;
}
function runtime(store: EventStore, agentPath: string) {
  const value = Object.create(StationRuntime.prototype) as any;
  value.orchestrationEventStore = store;
  value.agentConfigurationRevision = 0;
  value.agentConfigurationMutationQueue = Promise.resolve();
  value.agentConfigurationMutationsClosed = false;
  value.agentConfigurationPersistenceRevision = 0;
  value.agentConfigurationActivationEpoch = 0;
  value.loadedProviderLaunchabilityRevision = null;
  value.loadedAppConfigLaunchabilityRevision = null;
  value.loadedSelectedPackageFingerprint = null;
  value.providerService = { getLaunchabilityRevision: () => 0 };
  value.configLoader = {
    getLaunchabilityRevision: () => 0,
    loadAppConfig: async () => ({}),
  };
  value.activeAgents = new Map();
  value.appConfig = {};
  // Only the provider-backed Agent builder is controlled. The public reload,
  // revision capture/publication and reconciliation/admission methods are real.
  value.reloadDefaultAgentFromConfig = vi.fn(async () => {
    const selected = store
      .createPackageMcpAdmissionJournal()
      .selectedInstallations();
    if (selected.state !== 'observed')
      throw new Error('Fixture selection unavailable');
    value.activeAgents.set('default', {
      spec: JSON.parse(readFileSync(agentPath, 'utf8')),
      selection: selected.installations,
    });
  });
  value.rebuildGlobalToolRegistry = vi.fn();
  value.reloadConfigurationFromDisk = vi.fn(async () => {
    const before = value.captureAgentConfigurationRevisions();
    await value.reloadDefaultAgentFromConfig({});
    value.assertAgentConfigurationRevisions(before);
    value.recordLoadedConfigurationRevisions(before);
  });
  return value;
}

test('a second runtime selection change fences unchanged AgentSpec until the real reload/reconciliation path rebuilds it', async () => {
  const f = sharedHome();
  const journal = f.second.createPackageMcpAdmissionJournal();
  const original = select(journal);
  const a = runtime(f.first, f.agentPath),
    b = runtime(f.second, f.agentPath);
  await a.reloadDefaultAgent();
  await b.reloadDefaultAgent();
  expect(a.getStableAgentConfigurationRevision()).toBe(2);
  expect(b.getStableAgentConfigurationRevision()).toBe(2);
  const specBytes = readFileSync(f.agentPath, 'utf8');
  const captured = a.captureAgentConfigurationRevisions();
  const replacement = select(journal, original); // identical bytes, different canonical generation
  expect(replacement.contentDigest).toBe(original.contentDigest);
  expect(replacement.incarnation).not.toBe(original.incarnation);
  expect(readFileSync(f.agentPath, 'utf8')).toBe(specBytes);
  expect(a.getStableAgentConfigurationRevision()).toBeNull();
  expect(b.getStableAgentConfigurationRevision()).toBeNull();
  expect(() => a.assertAgentConfigurationRevisions(captured)).toThrow(
    'configuration changed',
  );
  const loadAgent = vi.fn(async () =>
    JSON.parse(readFileSync(f.agentPath, 'utf8')),
  );
  await expect(
    loadStablePreToolPolicySpec({
      getStableRevision: () => a.getStableAgentConfigurationRevision(),
      loadAgent,
    }),
  ).rejects.toThrow('not stable');
  expect(loadAgent).not.toHaveBeenCalled();
  await b.reloadDefaultAgent();
  expect(b.getStableAgentConfigurationRevision()).toBe(4);
  expect(a.getStableAgentConfigurationRevision()).toBeNull();
  await expect(a.reconcileAgentConfigurationSources()).resolves.toBe(true);
  expect(a.reloadConfigurationFromDisk).toHaveBeenCalledOnce();
  expect(a.activeAgents.get('default').selection[0].incarnation).toBe(
    replacement.incarnation,
  );
  expect(a.getStableAgentConfigurationRevision()).toBe(4);
  await expect(a.reconcileAgentConfigurationSources()).resolves.toBe(false);
  expect(a.reloadConfigurationFromDisk).toHaveBeenCalledOnce();
});

test('pending selections invalidate old loaded fingerprints without granting pending package admission', async () => {
  const f = sharedHome(),
    a = runtime(f.first, f.agentPath);
  await a.reloadDefaultAgent();
  const before = a.captureAgentConfigurationRevisions();
  const journal = f.second.createPackageMcpAdmissionJournal();
  const selected = journal.recordInstallation({
    pluginId: 'pending-fixture',
    contentDigest: digest,
    previous: null,
    origin: 'b'.repeat(64),
    activationPlan: {
      version: 1,
      artifactDigest: digest,
      descriptorDigest: digest,
      sourceDigest: digest,
      origin: 'b'.repeat(64),
      previous: null,
      consent: { kind: 'no-operator-decision', caller: 'fingerprint-fixture' },
      agents: [],
      ownedDependencies: [],
    },
  });
  if (selected.state !== 'recorded')
    throw new Error('Pending fixture could not be selected');
  expect(journal.activationState(selected.installation)).toBe('pending');
  expect(journal.admissionOpen(selected.installation)).toBe(false);
  expect(
    a.captureAgentConfigurationRevisions().selectedPackageFingerprint,
  ).not.toBe(before.selectedPackageFingerprint);
  expect(a.getStableAgentConfigurationRevision()).toBeNull();
  expect(journal.reserve(selected.installation, 'managed')).toEqual({
    state: 'blocked',
  });
});

test('selection movement during public reload rejects publication and a later reload recovers', async () => {
  const f = sharedHome(),
    a = runtime(f.first, f.agentPath);
  const journal = f.second.createPackageMcpAdmissionJournal();
  const original = select(journal);
  await a.reloadDefaultAgent();
  const build = a.reloadDefaultAgentFromConfig.getMockImplementation();
  a.reloadDefaultAgentFromConfig.mockImplementationOnce(async () => {
    select(journal, original);
    await build();
  });
  await expect(a.reloadDefaultAgent()).rejects.toThrow('configuration changed');
  expect(a.getStableAgentConfigurationRevision()).toBeNull();
  await expect(a.reloadDefaultAgent()).resolves.toBeUndefined();
  expect(a.getStableAgentConfigurationRevision()).toBe(6);
});

test('corrupt or missing journal evidence fails closed and only current captured selection can restore readiness', async () => {
  const f = sharedHome(),
    a = runtime(f.first, f.agentPath);
  const original = select(f.second.createPackageMcpAdmissionJournal());
  await a.reloadDefaultAgent();
  const saved = a.captureAgentConfigurationRevisions();
  const db = new DatabaseSync(f.path);
  cleanups.push(() => db.close());
  const row = db
    .prepare(
      'SELECT state_json FROM package_mcp_admission_journal WHERE singleton = 1',
    )
    .get() as { state_json: string };
  db.prepare(
    'UPDATE package_mcp_admission_journal SET state_json = ? WHERE singleton = 1',
  ).run('{bad');
  expect(a.getStableAgentConfigurationRevision()).toBeNull();
  expect(() => a.captureAgentConfigurationRevisions()).toThrow(
    'could not be verified',
  );
  a.recordLoadedConfigurationRevisions(saved); // must not manufacture a fresh fingerprint
  expect(a.getStableAgentConfigurationRevision()).toBeNull();
  db.prepare(
    'UPDATE package_mcp_admission_journal SET state_json = ? WHERE singleton = 1',
  ).run(row.state_json);
  select(f.second.createPackageMcpAdmissionJournal(), original);
  expect(a.getStableAgentConfigurationRevision()).toBeNull();
  await a.reloadDefaultAgent();
  expect(a.getStableAgentConfigurationRevision()).toBe(4);
  a.recordLoadedConfigurationRevisions({ provider: 0, appConfig: 0 });
  expect(a.getStableAgentConfigurationRevision()).toBeNull();
  a.orchestrationEventStore = undefined;
  expect(a.getStableAgentConfigurationRevision()).toBeNull();
  expect(() => a.captureAgentConfigurationRevisions()).toThrow(
    'could not be verified',
  );
});

test('claim activity is not a selected-generation revision', async () => {
  const f = sharedHome(),
    a = runtime(f.first, f.agentPath);
  const journal = f.second.createPackageMcpAdmissionJournal(),
    installation = select(journal);
  await a.reloadDefaultAgent();
  const before =
    a.captureAgentConfigurationRevisions().selectedPackageFingerprint;
  const reserved = journal.reserve(installation, 'managed');
  if (reserved.state !== 'reserved') throw new Error('Fixture reserve failed');
  expect(
    a.captureAgentConfigurationRevisions().selectedPackageFingerprint,
  ).toBe(before);
  expect(a.getStableAgentConfigurationRevision()).toBe(2);
  expect(reserved.claim.releaseNotStarted().state).toBe('applied');
  expect(a.getStableAgentConfigurationRevision()).toBe(2);
});
