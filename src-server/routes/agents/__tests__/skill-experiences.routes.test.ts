import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import {
  type EnvironmentRef,
  environmentId,
} from '@kontourai/station-contracts/execution-target';
import type {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { SkillExperienceInventoryV1 } from '@kontourai/station-contracts/skill-experience';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import type { ProviderAdapterMetadata } from '../../../providers/adapter-shape.js';
import { SkillService } from '../../../services/agents/skill-service.js';
import {
  type ExecutionTargetExecutionDependencies,
  executeForegroundMessage,
} from '../../../services/execution-target/execution-target-execution.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { AgentPluginLoader } from '../../../services/plugins/agent-plugin-loader.js';
import {
  pluginActivationDescriptorDigest,
  verifyPluginActivation,
} from '../../../services/plugins/plugin-activation-plan.js';
import { computePluginContentDigest } from '../../../services/plugins/plugin-content-integrity.js';
import { createLocalPluginInstallationService } from '../../../services/plugins/plugin-installation-local.js';
import { readPluginManifestFile } from '../../../services/plugins/plugin-manifest-loader.js';
import {
  grantPermissions,
  revokeGrants,
} from '../../../services/plugins/plugin-permissions.js';
import { createOrchestrationRoutes } from '../../orchestration/orchestration.js';
import { createSkillRoutes } from '../skills.js';

const makeTempDir = trackTempDirs();
const scratch: Array<{ home: string; store: EventStore }> = [];
afterEach(() => {
  for (const { home, store } of scratch.splice(0)) {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

async function installedExperience(
  change?: (source: string) => void,
  example = 'examples/visual-skill-experience',
) {
  const home = makeTempDir('station-experience-route-');
  const source = join(home, 'source');
  cpSync(resolve(example), source, {
    recursive: true,
  });
  change?.(source);
  const plugins = join(home, 'plugins');
  mkdirSync(plugins);
  const store = new EventStore(join(home, 'events.sqlite'));
  scratch.push({ home, store });
  const journal = store.createPackageMcpAdmissionJournal();
  const manifest = await readPluginManifestFile(join(source, 'plugin.json'));
  const pluginId = manifest.name;
  const digest = computePluginContentDigest(dirname(source), basename(source))!;
  await createLocalPluginInstallationService(plugins, journal, source).install({
    installation: pluginId,
    expected: null,
    artifact: { digest },
    origin: 'b'.repeat(64),
    activationPlan: {
      version: 1,
      artifactDigest: digest,
      sourceDigest: digest,
      descriptorDigest: pluginActivationDescriptorDigest(manifest),
      origin: 'b'.repeat(64),
      consent: { kind: 'no-operator-decision', caller: 'experience-fixture' },
      previous: null,
      agents: [],
      ownedDependencies: [],
    },
  });
  const loader = new AgentPluginLoader({
    projectHomeDir: home,
    journal: () => journal,
  });
  const config = new ConfigLoader({ projectHomeDir: home });
  const logger = { info() {}, warn() {}, debug() {} };
  const skills = new SkillService(config, logger, {
    canonicalSources: () => loader.skillSources(),
    experienceInventory: () => loader.listSkillExperiences(),
    experienceSource: (identity, effect, permission) =>
      loader.withSkillExperience(identity, effect, permission),
  });
  const routes = createSkillRoutes(skills, () => home);
  const current = journal.currentInstallation(pluginId);
  if (current.state !== 'observed') throw new Error('Installation missing');
  const installation = current.installation;
  async function inventory(rediscover = true) {
    if (rediscover) await skills.discoverSkills(home);
    const response = await routes.request('/experiences');
    expect(response.status).toBe(200);
    const result: { success: boolean; data: SkillExperienceInventoryV1 } =
      await readJson(response);
    expect(result.success).toBe(true);
    return result.data;
  }
  async function activate() {
    const permit = journal.claimActivation(installation);
    await verifyPluginActivation(permit, journal, async () => {});
    expect(journal.completeActivation(permit)).toEqual({ state: 'applied' });
  }
  return {
    home,
    store,
    source,
    plugins,
    pluginId,
    loader,
    skills,
    journal,
    installation,
    inventory,
    activate,
  };
}

test('the real skill route publishes installed definitions only after activation and withdraws them on retirement', async () => {
  const fixture = await installedExperience();
  expect(await fixture.inventory()).toMatchObject({
    experiences: [],
    diagnostics: [{ code: 'unavailable' }],
  });
  await fixture.activate();
  const available = await fixture.inventory();
  expect(available.diagnostics).toEqual([]);
  expect(available.experiences).toHaveLength(1);
  expect(available.experiences[0]).toMatchObject({
    identity: {
      pluginId: 'visual-skill-experience',
      pluginVersion: '1.0.0',
      experienceId: 'stress-test-idea',
      incarnation: fixture.installation.incarnation,
      materialization: fixture.installation.materialization,
      contentDigest: fixture.installation.contentDigest,
    },
    definition: {
      title: 'Stress-test an idea',
      skills: [{ name: 'stress-test-idea' }],
    },
  });
  expect(available.experiences[0]!.identity.definitionDigest).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(fixture.journal.requestRetirement(fixture.installation).state).toBe(
    'fenced',
  );
  expect(await fixture.inventory()).toMatchObject({
    experiences: [],
    diagnostics: [{ code: 'unavailable' }],
  });
});

test('changed installed bytes cannot reuse catalog availability', async () => {
  const fixture = await installedExperience();
  await fixture.activate();
  const available = await fixture.inventory();
  expect(available.experiences).toHaveLength(1);
  const root = fixture.loader.listInstalled()[0]!.root;
  writeFileSync(
    join(root, 'skills/stress-test-idea/SKILL.md'),
    'Changed after admission',
  );
  expect(await fixture.inventory()).toMatchObject({
    experiences: [],
    diagnostics: [{ code: 'unavailable' }],
  });
});

test.each(['digest', 'dependency', 'version', 'escape'] as const)(
  'an admitted package with a %s error cannot publish a visual definition',
  async (failure) => {
    const fixture = await installedExperience((source) => {
      const path = join(
        source,
        'io.kontourai.station/experiences/stress-test-idea.json',
      );
      const definition = JSON.parse(readFileSync(path, 'utf8'));
      if (failure === 'digest') definition.skills[0].sha256 = '0'.repeat(64);
      if (failure === 'dependency')
        definition.skills[0].dependsOn = ['missing'];
      if (failure === 'version') definition.schemaVersion = '2.0';
      if (failure === 'escape') {
        const skill = join(source, 'skills/stress-test-idea/SKILL.md');
        const outside = join(dirname(source), 'outside.md');
        writeFileSync(outside, readFileSync(skill));
        rmSync(skill);
        symlinkSync(outside, skill);
      }
      writeFileSync(path, JSON.stringify(definition));
    });
    await fixture.activate();
    const result = await fixture.inventory();
    expect(result.experiences).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'definition-invalid' }),
    ]);
    if (failure !== 'escape') {
      await fixture.skills.discoverSkills(fixture.home);
      expect(fixture.skills.listSkills().map((skill) => skill.name)).toContain(
        'stress-test-idea',
      );
    }
  },
);

test('an ordinary third-party package is discoverable without a renderer allowlist', async () => {
  const fixture = await installedExperience((source) => {
    const path = join(source, 'plugin.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.name = 'independent-author-tools';
    writeFileSync(path, JSON.stringify(manifest));
  });
  await fixture.activate();
  expect((await fixture.inventory()).experiences[0]?.identity.pluginId).toBe(
    'independent-author-tools',
  );
});

test('a local Skill override makes the pinned experience unavailable without rebinding its identity', async () => {
  const fixture = await installedExperience();
  await fixture.activate();
  expect((await fixture.inventory()).experiences).toHaveLength(1);
  const directory = join(fixture.home, 'skills/stress-test-idea');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    '---\nname: stress-test-idea\ndescription: Local alternative\n---\nDifferent instructions.',
  );
  expect(await fixture.inventory()).toMatchObject({
    experiences: [],
    diagnostics: [
      { code: 'unavailable', message: expect.stringContaining('overridden') },
    ],
  });
});

test('same-version replacement cannot publish against the previous discovered Skill generation', async () => {
  const fixture = await installedExperience();
  await fixture.activate();
  const old = (await fixture.inventory()).experiences[0]!.identity;
  const definitionPath = join(
    fixture.source,
    'io.kontourai.station/experiences/stress-test-idea.json',
  );
  const definition = JSON.parse(readFileSync(definitionPath, 'utf8'));
  definition.title = 'Updated interview';
  writeFileSync(definitionPath, JSON.stringify(definition));
  const service = createLocalPluginInstallationService(
    fixture.plugins,
    fixture.journal,
    fixture.source,
  );
  const previous = await service.inspect(fixture.pluginId);
  const manifest = await readPluginManifestFile(
    join(fixture.source, 'plugin.json'),
  );
  const digest = computePluginContentDigest(
    dirname(fixture.source),
    basename(fixture.source),
  )!;
  await service.install({
    installation: fixture.pluginId,
    expected: previous,
    artifact: { digest },
    origin: 'b'.repeat(64),
    activationPlan: {
      version: 1,
      artifactDigest: digest,
      sourceDigest: digest,
      descriptorDigest: pluginActivationDescriptorDigest(manifest),
      origin: 'b'.repeat(64),
      consent: { kind: 'no-operator-decision', caller: 'experience-fixture' },
      previous,
      agents: [],
      ownedDependencies: [],
    },
  });
  const current = fixture.journal.currentInstallation(fixture.pluginId);
  if (current.state !== 'observed') throw new Error('Replacement missing');
  const permit = fixture.journal.claimActivation(current.installation);
  await verifyPluginActivation(permit, fixture.journal, async () => {});
  expect(fixture.journal.completeActivation(permit)).toEqual({
    state: 'applied',
  });
  expect(await fixture.inventory(false)).toMatchObject({
    experiences: [],
    diagnostics: [{ code: 'unavailable' }],
  });
  const refreshed = (await fixture.inventory()).experiences[0]!;
  expect(refreshed.definition.title).toBe('Updated interview');
  expect(refreshed.identity.incarnation).not.toBe(old.incarnation);
  expect(refreshed.identity.materialization).not.toBe(old.materialization);
});

test.each(['syntax', 'schema'] as const)(
  'selected manifest %s corruption remains a named refusal instead of disappearing from discovery',
  async (failure) => {
    const fixture = await installedExperience();
    await fixture.activate();
    const root = fixture.loader.listInstalled()[0]!.root;
    const path = join(root, 'plugin.json');
    if (failure === 'syntax') writeFileSync(path, '{');
    else {
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      delete manifest.$schema;
      writeFileSync(path, JSON.stringify(manifest));
    }
    expect(await fixture.inventory(false)).toMatchObject({
      experiences: [],
      diagnostics: [{ pluginId: fixture.pluginId, code: 'unavailable' }],
    });
  },
);

test('journal-observed legacy packages cannot invent managed materialization identity', async () => {
  const home = makeTempDir('station-experience-legacy-');
  const root = join(home, 'plugins/visual-skill-experience');
  cpSync(resolve('examples/visual-skill-experience'), root, {
    recursive: true,
  });
  const store = new EventStore(join(home, 'events.sqlite'));
  scratch.push({ home, store });
  const journal = store.createPackageMcpAdmissionJournal();
  const recorded = journal.recordInstallation({
    pluginId: 'visual-skill-experience',
    contentDigest: computePluginContentDigest(dirname(root), basename(root))!,
    previous: null,
  });
  if (recorded.state !== 'recorded')
    throw new Error('Legacy fixture not recorded');
  expect(journal.admissionOpen(recorded.installation)).toBe(true);
  const loader = new AgentPluginLoader({
    projectHomeDir: home,
    journal: () => journal,
  });
  const skills = new SkillService(
    new ConfigLoader({ projectHomeDir: home }),
    { info() {}, warn() {}, debug() {} },
    {
      canonicalSources: () => loader.skillSources(),
      experienceInventory: () => loader.listSkillExperiences(),
      experienceSource: (identity, effect) =>
        loader.withSkillExperience(identity, effect),
    },
  );
  await skills.discoverSkills(home);
  const response = await createSkillRoutes(skills, () => home).request(
    '/experiences',
  );
  expect(response.status).toBe(200);
  const body = await readJson<{ data: SkillExperienceInventoryV1 }>(response);
  expect(body.data).toMatchObject({
    experiences: [],
    diagnostics: [{ code: 'unavailable' }],
  });
});

class ExperienceAdapter extends GateTestAdapter {
  override readonly metadata: ProviderAdapterMetadata = {
    displayName: 'Claude Code',
    description: 'Recording engine for pinned experience delivery',
    capabilities: ['agent-runtime', 'file-input', 'image-input'],
  };
  readonly turns: ProviderSendTurnInput[] = [];
  readonly decisions: string[] = [];
  readonly sessions = new Set<string>();
  override async hasSession(threadId?: string) {
    return Boolean(threadId && this.sessions.has(threadId));
  }
  override async startSession(input: ProviderSessionStartInput) {
    this.sessions.add(input.threadId);
    this.events.push({
      eventId: `${input.threadId}:configured`,
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      method: 'session.configured',
      createdAt: new Date().toISOString(),
      metadata: input.metadata,
    });
    return super.startSession(input);
  }
  override async sendTurn(input: ProviderSendTurnInput) {
    this.turns.push(input);
    const turnId = `turn:${this.turns.length}`;
    this.events.push({
      eventId: `${input.threadId}:${turnId}`,
      provider: this.provider,
      threadId: input.threadId,
      turnId,
      method: 'turn.started',
      createdAt: new Date().toISOString(),
      metadata: input.metadata,
      attachments: input.attachments,
      prompt: input.displayInput ?? input.input,
    });
    return { threadId: input.threadId, turnId };
  }
  override async respondToRequest(
    _threadId?: string,
    _requestId?: string,
    decision?: string,
  ) {
    this.decisions.push(decision ?? '');
  }
}

async function experienceRuntime(
  projectEnvironment?: EnvironmentRef,
  change?: (source: string) => void,
  example?: string,
) {
  const fixture = await installedExperience(change, example);
  await fixture.activate();
  const inventory = await fixture.inventory();
  const adapter = new ExperienceAdapter();
  const eventBus = new EventBus();
  const service = new OrchestrationService({
    eventStore: fixture.store,
    eventBus,
    adapterRegistry: createGateTestRegistry(adapter),
    resolveSessionAgent: async (input) => ({
      ...input,
      agent: { slug: 'claude' },
    }),
    listProjects: () => [
      { slug: 'project-one', workingDirectory: fixture.home },
    ],
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  expect(service.registerSkillExperienceSource(fixture.skills)).toBe(true);
  fixture.skills.enableExperienceExecution();
  service.initialize();
  let selection:
    | import('@kontourai/station-contracts/skill-experience').SkillExperienceStartInputV1
    | undefined;
  const dependencies: ExecutionTargetExecutionDependencies = {
    resolveEnvironmentAccess: async () => ({
      apiBase: 'http://experience.test',
      environmentId: 'experience-environment',
      environmentName: 'Experience Station',
      kind: 'current',
    }),
    getAgent: async () => ({
      slug: 'claude',
      available: true,
      execution: { agentConnectionId: engineConnectionId('claude') },
    }),
    getConnection: async () => ({
      id: engineConnectionId('claude'),
      name: 'Claude',
      type: 'claude',
      kind: 'agent',
      enabled: true,
      status: 'ready',
      capabilities: ['agent-runtime'],
      prerequisites: [],
      config: { provider: 'claude' },
    }),
    getProject: async (_access, slug) =>
      slug === 'project-one' ? { workingDirectory: fixture.home } : undefined,
    getProviderAdapter: (provider) => service.getProviderAdapter(provider),
    readSessionBinding: async (_access, id) => {
      const root = fixture.store.conversationSessions(id)[0]?.sessionId ?? id;
      const event = [...fixture.store.listEvents(root)]
        .reverse()
        .find(
          (value) => value.payload.method === 'session.configured',
        )?.payload;
      const metadata =
        event?.method === 'session.configured' ? event.metadata : undefined;
      return metadata && typeof metadata.environmentId === 'string'
        ? {
            environmentId: metadata.environmentId,
            agentId: 'claude',
            userId: 'experience-owner',
            ...(typeof metadata.projectSlug === 'string'
              ? { projectSlug: metadata.projectSlug }
              : {}),
          }
        : null;
    },
    resolveConversationSession: async (_access, id, requested) =>
      service.resolveConversationContinuation(
        id,
        INTERNAL_SESSION_READ_SCOPE,
        requested,
      ),
    startSession: async (_access, input) => {
      const started = await service.startSessionInternal(
        { type: 'start-session', input },
        { userId: 'experience-owner' },
        {
          conversationIdentity: {
            conversationId: String(input.metadata?.conversationId),
            environmentId: String(input.metadata?.environmentId),
          },
        },
      );
      if (started.status !== 'accepted') throw new Error(started.message);
      await vi.waitFor(() =>
        expect(
          fixture.store
            .listEvents(input.threadId)
            .some((event) => event.method === 'session.configured'),
        ).toBe(true),
      );
      return {
        commandId: started.receipt.commandId,
        sessionId: input.threadId,
      };
    },
    sendTurn: async (_access, input) => {
      const result = await service.dispatchWithReceipt(
        { type: 'sendTurn', input },
        { userId: 'experience-owner' },
        { skillExperience: selection },
      );
      if (!result.result || !('turnId' in result.result))
        throw new Error('No accepted turn');
      return { turnId: result.result.turnId };
    },
    createConversationId: () => 'experience-session',
  };
  const routes = createOrchestrationRoutes(service, {
    eventBus,
    logger: { debug: vi.fn() },
    getUserId: () => 'experience-owner',
    projectDefaultEnvironment: () => projectEnvironment ?? { kind: 'current' },
    executeForegroundMessage: async (input) => {
      selection = input.skillExperience;
      return executeForegroundMessage(input, dependencies);
    },
  });
  return {
    ...fixture,
    adapter,
    eventBus,
    service,
    routes,
    identity: inventory.experiences[0]!.identity,
  };
}

async function selectedTurn(
  fixture: Awaited<ReturnType<typeof experienceRuntime>>,
  inputs: Record<string, string> = { idea: 'A careful review process' },
) {
  const response = await fixture.routes.request('/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      target: { environment: { kind: 'current' }, agent: 'claude' },
      message: 'Start this interview',
      clientTurnId: 'experience-client-turn',
      skillExperience: { identity: fixture.identity, inputs },
    }),
  });
  return response;
}

test('foreground selection reaches the real provider, retains only the accepted canonical turn and survives restart as inert history', async () => {
  const fixture = await experienceRuntime();
  try {
    expect((await fixture.inventory()).executionContract).toBe('1.0');
    const selected = await selectedTurn(fixture);
    expect(
      selected.status,
      JSON.stringify(await readJson(selected.clone())),
    ).toBe(200);
    await vi.waitFor(() =>
      expect(
        fixture.store.listSkillExperienceEvents('experience-session'),
      ).toHaveLength(1),
    );
    expect(fixture.adapter.turns[0]!.input).toContain(
      'A careful review process',
    );
    expect(fixture.adapter.turns[0]!.input).toContain('stress-test-idea');
    const view = await fixture.service.readSkillExperience(
      'experience-session',
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(view?.current).toMatchObject({
      eventId: 'experience-session:turn:1',
      turnId: 'turn:1',
      availability: { status: 'available' },
      snapshot: {
        inputs: { idea: 'A careful review process' },
        clientTurnId: 'experience-client-turn',
        questionnaireDelivery: 'canonical-request',
      },
    });
    expect(view?.current?.reference?.snapshotSessionId).toBe(
      'experience-session',
    );
    const other = new EventStore(join(fixture.home, 'events.sqlite'));
    try {
      expect(
        other.createSkillExperienceSnapshots().read(view!.current!.reference!),
      ).toMatchObject({ inputs: { idea: 'A careful review process' } });
    } finally {
      other.close();
    }
    const unauthorized = createOrchestrationRoutes(fixture.service, {
      eventBus: fixture.eventBus,
      logger: { debug: vi.fn() },
      getUserId: () => 'another-owner',
    });
    expect(
      (
        await unauthorized.request(
          '/sessions/experience-session/skill-experience',
        )
      ).status,
    ).toBe(404);
  } finally {
    await fixture.service.shutdown();
  }
});

test('changed sources block ordinary send and accepting a request while cancellation still reaches the provider', async () => {
  const fixture = await experienceRuntime();
  try {
    const selected = await selectedTurn(fixture);
    expect(
      selected.status,
      JSON.stringify(await readJson(selected.clone())),
    ).toBe(200);
    await vi.waitFor(() =>
      expect(
        fixture.store.listSkillExperienceEvents('experience-session'),
      ).toHaveLength(1),
    );
    const root = fixture.loader.skillSources()[0]!.containmentRoot!;
    writeFileSync(
      join(root, 'skills/stress-test-idea/SKILL.md'),
      'changed source',
    );
    await expect(
      fixture.service.dispatchWithReceipt(
        {
          type: 'sendTurn',
          input: {
            threadId: 'experience-session',
            input: 'continue',
            clientTurnId: 'continued-turn',
          },
        },
        { userId: 'experience-owner' },
      ),
    ).rejects.toThrow(/source|revision|unavailable/i);
    expect(fixture.adapter.turns).toHaveLength(1);
    fixture.adapter.events.push({
      eventId: 'request-event',
      provider: 'claude',
      threadId: 'experience-session',
      turnId: 'turn:1',
      method: 'request.opened',
      requestId: 'request-one',
      requestType: 'approval',
      createdAt: new Date().toISOString(),
    } as CanonicalRuntimeEvent);
    await vi.waitFor(() =>
      expect(
        fixture.store.readCurrentRequestEvent(
          'experience-session',
          'request-one',
        ).state,
      ).toBe('found'),
    );
    await expect(
      fixture.service.dispatchWithReceipt(
        {
          type: 'respondToRequest',
          threadId: 'experience-session',
          requestId: 'request-one',
          decision: 'accept',
        },
        { userId: 'experience-owner' },
      ),
    ).rejects.toThrow(/source|revision|unavailable/i);
    expect(fixture.adapter.decisions).toEqual([]);
    await fixture.service.dispatchWithReceipt(
      {
        type: 'respondToRequest',
        threadId: 'experience-session',
        requestId: 'request-one',
        decision: 'decline',
      },
      { userId: 'experience-owner' },
    );
    expect(fixture.adapter.decisions).toEqual(['decline']);
    const view = await fixture.service.readSkillExperience(
      'experience-session',
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(view?.current).toMatchObject({
      snapshot: { inputs: { idea: 'A careful review process' } },
      availability: { status: 'source-unavailable' },
    });
  } finally {
    await fixture.service.shutdown();
  }
});

test('invalid declared inputs and unsupported dispatch leave no canonical experience invocation', async () => {
  const fixture = await experienceRuntime();
  try {
    const invalid = await selectedTurn(fixture, { forgedField: 'data' });
    expect(
      invalid.status,
      JSON.stringify(await readJson(invalid.clone())),
    ).toBe(400);
    expect(fixture.adapter.turns).toEqual([]);
    expect(
      fixture.store.listSkillExperienceEvents('experience-session'),
    ).toEqual([]);
    const body = {
      target: {
        environment: { kind: 'saved', id: 'other-station' },
        agent: 'claude',
      },
      message: 'start',
      clientTurnId: 'client',
      skillExperience: { identity: fixture.identity, inputs: { idea: 'test' } },
    };
    expect(
      (
        await fixture.routes.request('/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(400);
    expect(fixture.adapter.turns).toEqual([]);
  } finally {
    await fixture.service.shutdown();
  }
});

test('canonical project chat shape resolves omitted Environment locally and refuses inherited remote execution before provider effects', async () => {
  const local = await experienceRuntime();
  const remote = await experienceRuntime({
    kind: 'saved',
    id: environmentId('remote-environment'),
  });
  try {
    const request = (fixture: Awaited<ReturnType<typeof experienceRuntime>>) =>
      fixture.routes.request('/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target: {
            agent: agentId('claude'),
            workspace: { kind: 'project', projectSlug: 'project-one' },
          },
          message: 'Start',
          clientTurnId: 'project-turn',
          skillExperience: {
            identity: fixture.identity,
            inputs: { idea: 'Local project review' },
          },
        }),
      });
    const accepted = await request(local);
    expect(
      accepted.status,
      JSON.stringify(await readJson(accepted.clone())),
    ).toBe(200);
    expect(local.adapter.turns).toHaveLength(1);
    const refused = await request(remote);
    expect(
      refused.status,
      JSON.stringify(await readJson(refused.clone())),
    ).toBe(400);
    expect(remote.adapter.turns).toEqual([]);
    expect(remote.store.readSessions()).toEqual([]);
  } finally {
    await local.service.shutdown();
    await remote.service.shutdown();
  }
});

test('a pinned dependency closure reaches the real foreground adapter and a same-name foreign Skill cannot substitute its instructions', async () => {
  const fixture = await experienceRuntime(undefined, (source) => {
    const file = join(
      source,
      'io.kontourai.station/experiences/stress-test-idea.json',
    );
    const definition: import('@kontourai/station-contracts/skill-experience').SkillExperienceDefinitionV1 =
      JSON.parse(readFileSync(file, 'utf8'));
    const original = readFileSync(
      join(source, 'skills/stress-test-idea/SKILL.md'),
      'utf8',
    );
    const dependent =
      original.replace('name: stress-test-idea', 'name: support-review') +
      '\nPINNED_DEPENDENCY_SENTINEL\n';
    mkdirSync(join(source, 'skills/support-review'));
    writeFileSync(join(source, 'skills/support-review/SKILL.md'), dependent);
    definition.entrySkillId = 'interview';
    definition.skills[0]!.dependsOn = ['support'];
    definition.skills.push({
      id: 'support',
      name: 'support-review',
      path: './skills/support-review/SKILL.md',
      sha256: createHash('sha256').update(dependent).digest('hex'),
      dependsOn: ['interview'],
    });
    writeFileSync(file, JSON.stringify(definition));
  });
  try {
    const selected = await selectedTurn(fixture);
    expect(
      selected.status,
      JSON.stringify(await readJson(selected.clone())),
    ).toBe(200);
    expect(fixture.adapter.turns[0]!.input).toContain(
      'PINNED_DEPENDENCY_SENTINEL',
    );
    expect(
      fixture.adapter.turns[0]!.input.match(/PINNED_DEPENDENCY_SENTINEL/g),
    ).toHaveLength(1);
    expect(fixture.adapter.turns[0]!.input).toContain(
      'Selected entry Skill: stress-test-idea',
    );
    expect(fixture.adapter.turns[0]!.displayInput).toBe('Start this interview');
    await vi.waitFor(() =>
      expect(
        fixture.store.listSkillExperienceEvents('experience-session'),
      ).toHaveLength(1),
    );
    expect(
      fixture.store.listSkillExperienceEvents('experience-session')[0]!.payload,
    ).toMatchObject({ prompt: 'Start this interview' });
    const local = join(fixture.home, 'skills/support-review');
    mkdirSync(local, { recursive: true });
    writeFileSync(
      join(local, 'SKILL.md'),
      '---\nname: support-review\ndescription: A foreign override\n---\nFOREIGN_SOURCE_SENTINEL\n',
    );
    await fixture.skills.discoverSkills(fixture.home);
    await expect(
      fixture.service.dispatchWithReceipt(
        {
          type: 'sendTurn',
          input: {
            threadId: 'experience-session',
            input: 'continue',
            clientTurnId: 'dependency-follow-up',
          },
        },
        { userId: 'experience-owner' },
      ),
    ).rejects.toThrow(/source|scope|unavailable/i);
    expect(fixture.adapter.turns).toHaveLength(1);
    expect(fixture.adapter.turns[0]!.input).not.toContain(
      'FOREIGN_SOURCE_SENTINEL',
    );
  } finally {
    await fixture.service.shutdown();
  }
});

test('rich actions bind the exact invocation and fresh plugin grant while ordinary user controls keep their authority', async () => {
  const fixture = await experienceRuntime(undefined, (source) => {
    const file = join(source, 'plugin.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.extensions['io.kontourai.station'].permissions = ['agents.invoke'];
    writeFileSync(file, JSON.stringify(manifest));
  });
  try {
    const selected = await selectedTurn(fixture);
    expect(
      selected.status,
      JSON.stringify(await readJson(selected.clone())),
    ).toBe(200);
    await vi.waitFor(() =>
      expect(
        fixture.store.listSkillExperienceEvents('experience-session'),
      ).toHaveLength(1),
    );
    const expected = {
      identity: fixture.identity,
      eventId:
        fixture.store.listSkillExperienceEvents('experience-session')[0]!.id,
    };
    await expect(
      fixture.service.readSkillExperience(
        'experience-session',
        INTERNAL_SESSION_READ_SCOPE,
        undefined,
        undefined,
        expected,
      ),
    ).rejects.toThrow(/permission/);
    await grantPermissions(fixture.home, fixture.pluginId, ['agents.invoke']);
    const view = await fixture.service.readSkillExperience(
      'experience-session',
      INTERNAL_SESSION_READ_SCOPE,
      undefined,
      undefined,
      expected,
    );
    expect(view?.current?.eventId).toBe(expected.eventId);
    await expect(
      fixture.service.readSkillExperience(
        'experience-session',
        INTERNAL_SESSION_READ_SCOPE,
        undefined,
        undefined,
        { ...expected, eventId: 'another-event' },
      ),
    ).rejects.toThrow(/changed/);
    fixture.adapter.events.push({
      eventId: 'rich-question-event',
      provider: 'claude',
      threadId: 'experience-session',
      turnId: 'turn:1',
      method: 'request.opened',
      requestId: 'rich-question',
      requestType: 'approval',
      title: 'Approve',
      createdAt: new Date().toISOString(),
    });
    await vi.waitFor(() =>
      expect(
        fixture.store.readCurrentRequestEvent(
          'experience-session',
          'rich-question',
        ).state,
      ).toBe('found'),
    );
    await revokeGrants(fixture.home, fixture.pluginId, ['agents.invoke']);
    await expect(
      fixture.service.dispatchWithReceipt(
        {
          type: 'respondToRequest',
          threadId: 'experience-session',
          requestId: 'rich-question',
          expectedRequestEventId: 'rich-question-event',
          expectedSkillExperience: expected,
          decision: 'accept',
        },
        { userId: 'experience-owner', requestCurrent: () => true },
      ),
    ).rejects.toThrow(/permission/);
    expect(fixture.adapter.decisions).toEqual([]);
    await fixture.service.dispatchWithReceipt(
      {
        type: 'respondToRequest',
        threadId: 'experience-session',
        requestId: 'rich-question',
        expectedRequestEventId: 'rich-question-event',
        decision: 'accept',
      },
      { userId: 'experience-owner', requestCurrent: () => true },
    );
    expect(fixture.adapter.decisions).toEqual(['accept']);
  } finally {
    await fixture.service.shutdown();
  }
});

test('the actual curated package loads explicit stages and delivers its pinned grilling source through real foreground execution', async () => {
  const fixture = await experienceRuntime(
    undefined,
    undefined,
    'examples/matt-pocock-engineering',
  );
  try {
    const inventory = await fixture.inventory();
    expect(inventory.diagnostics).toEqual([]);
    expect(inventory.experiences.map((entry) => entry.definition.id)).toEqual(
      expect.arrayContaining([
        'grill-me',
        'grill-with-docs',
        'to-spec',
        'to-tickets',
        'implement',
      ]),
    );
    const grilling = readFileSync(
      'examples/matt-pocock-engineering/skills/grilling/SKILL.md',
      'utf8',
    );
    const selected = await selectedTurn(fixture, {
      context: 'Plan a careful feature review process',
    });
    expect(
      selected.status,
      JSON.stringify(await readJson(selected.clone())),
    ).toBe(200);
    expect(fixture.adapter.turns[0]!.input).toContain(grilling);
    expect(fixture.adapter.turns[0]!.input).toContain(
      'Selected entry Skill: grill-me',
    );
    const implementation = inventory.experiences.find(
      (entry) => entry.definition.id === 'implement',
    )!;
    expect(implementation.definition.entrySkillId).toBe('implement');
    expect(implementation.definition.requiredContext).toContainEqual(
      expect.objectContaining({ kind: 'project', required: true }),
    );
    expect(fixture.adapter.turns).toHaveLength(1);
    const tickets = inventory.experiences.find(
      (entry) => entry.definition.id === 'to-tickets',
    )!;
    expect(
      tickets.definition.transitions?.map((stage) => stage.experienceId),
    ).toEqual(['implement']);
  } finally {
    await fixture.service.shutdown();
  }
});

test('an exact foreground retry returns the canonical accepted turn without invoking its Skill or provider again', async () => {
  const fixture = await experienceRuntime();
  try {
    const first = await selectedTurn(fixture);
    const firstBody = await readJson<{
      success: boolean;
      data: {
        conversationId: string;
        sessionId: string;
        providerTurnId: string;
      };
    }>(first);
    expect(first.status, JSON.stringify(firstBody)).toBe(200);
    await vi.waitFor(() =>
      expect(
        fixture.store.listSkillExperienceEvents('experience-session'),
      ).toHaveLength(1),
    );
    const retry = await fixture.routes.request('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { environment: { kind: 'current' }, agent: 'claude' },
        conversationId: 'experience-session',
        message: 'Start this interview',
        clientTurnId: 'experience-client-turn',
        skillExperience: {
          identity: fixture.identity,
          inputs: { idea: 'A careful review process' },
        },
      }),
    });
    expect(retry.status, JSON.stringify(await readJson(retry.clone()))).toBe(
      200,
    );
    const retried = await readJson(retry);
    expect(retried).toMatchObject({
      success: true,
      data: {
        conversationId: firstBody.data.conversationId,
        sessionId: firstBody.data.sessionId,
        providerTurnId: firstBody.data.providerTurnId,
      },
    });
    expect(fixture.adapter.turns).toHaveLength(1);
    expect(
      fixture.store.listSkillExperienceEvents('experience-session'),
    ).toHaveLength(1);
  } finally {
    await fixture.service.shutdown();
  }
});

test('initial and continued model input retain the declared attachment role assignments without embedding attachment bytes or local attachment paths in context', async () => {
  const fixture = await experienceRuntime(undefined, (source) => {
    const file = join(
      source,
      'io.kontourai.station/experiences/stress-test-idea.json',
    );
    const definition: import('@kontourai/station-contracts/skill-experience').SkillExperienceDefinitionV1 =
      JSON.parse(readFileSync(file, 'utf8'));
    definition.inputs.push(
      ...['reference', 'candidate'].map((id) => ({
        id,
        kind: 'attachments' as const,
        label: id,
        required: true,
        maxCount: 1,
        provenance: {
          origin: 'station-added' as const,
          explanation: 'The user assigns documents for comparison.',
        },
      })),
    );
    writeFileSync(file, JSON.stringify(definition));
  });
  try {
    const documents = ['baseline', 'candidate'].map((text, index) => ({
      kind: 'file',
      name: `document-${index}.txt`,
      mimeType: 'text/plain',
      size: Buffer.byteLength(text),
      dataUrl: `data:text/plain;base64,${Buffer.from(text).toString('base64')}`,
    }));
    const response = await fixture.routes.request('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { environment: { kind: 'current' }, agent: 'claude' },
        message: 'Compare the documents',
        clientTurnId: 'attachment-role-turn',
        attachments: documents,
        skillExperience: {
          identity: fixture.identity,
          inputs: { idea: 'Review the changes' },
          attachmentInputs: { reference: [1], candidate: [0] },
        },
      }),
    });
    expect(
      response.status,
      JSON.stringify(await readJson(response.clone())),
    ).toBe(200);
    expect(fixture.adapter.turns[0]!.input).toContain(
      '"reference":[1],"candidate":[0]',
    );
    expect(fixture.adapter.turns[0]!.attachments).toEqual(documents);
    expect(fixture.adapter.turns[0]!.input).not.toContain('data:text/plain');
    await vi.waitFor(() =>
      expect(
        fixture.store.listSkillExperienceEvents('experience-session'),
      ).toHaveLength(1),
    );
    await fixture.service.dispatchWithReceipt(
      {
        type: 'sendTurn',
        input: {
          threadId: 'experience-session',
          input: 'Continue the review',
          clientTurnId: 'continued-attachment-roles',
        },
      },
      { userId: 'experience-owner' },
    );
    expect(fixture.adapter.turns[1]!.input).toContain(
      '"reference":[1],"candidate":[0]',
    );
    const view = await fixture.service.readSkillExperience(
      'experience-session',
      INTERNAL_SESSION_READ_SCOPE,
    );
    expect(view?.current?.snapshot?.attachmentInputs).toEqual({
      reference: [1],
      candidate: [0],
    });
  } finally {
    await fixture.service.shutdown();
  }
});

test('declared stage selection follows canonical child Session lineage and preserves ordered immutable history', async () => {
  const fixture = await experienceRuntime(undefined, (source) => {
    const file = join(
      source,
      'io.kontourai.station/experiences/stress-test-idea.json',
    );
    const definition: import('@kontourai/station-contracts/skill-experience').SkillExperienceDefinitionV1 =
      JSON.parse(readFileSync(file, 'utf8'));
    definition.entrySkillId = 'interview';
    definition.transitions = [
      {
        experienceId: 'write-brief',
        label: 'Write a brief',
        provenance: {
          origin: 'station-added',
          explanation: 'An explicit next stage after reviewing decisions.',
        },
      },
    ];
    writeFileSync(file, JSON.stringify(definition));
    const content =
      '---\nname: write-brief\ndescription: Write a reviewed brief\n---\nBRIEF_STAGE_SENTINEL: summarize the reviewed decisions.\n';
    mkdirSync(join(source, 'skills/write-brief'));
    writeFileSync(join(source, 'skills/write-brief/SKILL.md'), content);
    const next = {
      ...definition,
      id: 'write-brief',
      title: 'Write a brief',
      skills: [
        {
          id: 'writer',
          name: 'write-brief',
          path: './skills/write-brief/SKILL.md',
          sha256: createHash('sha256').update(content).digest('hex'),
        },
      ],
      entrySkillId: 'writer',
      transitions: [],
      requiredContext: [
        {
          kind: 'conversation',
          required: true,
          provenance: {
            origin: 'station-added',
            explanation:
              'Continue reviewed decisions in the same conversation.',
          },
        },
      ],
      inputs: [
        {
          ...definition.inputs[0]!,
          provenance: {
            origin: 'station-added',
            explanation: 'The user confirms the context for this next stage.',
          },
        },
      ],
      interaction: {
        pattern: 'transform',
        stopConditions: ['Reviewed brief complete.'],
        unsupportedBehavior: ['No automatic next stage.'],
      },
      outputs: [
        {
          ...definition.outputs[0]!,
          provenance: {
            origin: 'station-added',
            explanation: 'A reviewed written brief.',
          },
        },
      ],
    };
    writeFileSync(
      join(source, 'io.kontourai.station/experiences/write-brief.json'),
      JSON.stringify(next),
    );
    const manifestFile = join(source, 'plugin.json');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.extensions['io.kontourai.station'].experiences.push({
      version: '1.0',
      id: 'write-brief',
      source: './io.kontourai.station/experiences/write-brief.json',
    });
    writeFileSync(manifestFile, JSON.stringify(manifest));
  });
  try {
    const initial = await selectedTurn(fixture);
    expect(
      initial.status,
      JSON.stringify(await readJson(initial.clone())),
    ).toBe(200);
    await vi.waitFor(() =>
      expect(
        fixture.store.listSkillExperienceEvents('experience-session'),
      ).toHaveLength(1),
    );
    const firstEvent =
      fixture.store.listSkillExperienceEvents('experience-session')[0]!;
    fixture.adapter.events.push({
      eventId: 'first-completed',
      provider: 'claude',
      threadId: 'experience-session',
      turnId: 'turn:1',
      method: 'turn.completed',
      createdAt: new Date().toISOString(),
    });
    fixture.adapter.events.push({
      eventId: 'first-session-exited',
      provider: 'claude',
      threadId: 'experience-session',
      sessionId: 'experience-session',
      method: 'session.exited',
      exitCode: 0,
      createdAt: new Date().toISOString(),
    });
    fixture.adapter.sessions.delete('experience-session');
    await vi.waitFor(() =>
      expect(
        fixture.store
          .listEvents('experience-session')
          .some((event) => event.id === 'first-session-exited'),
      ).toBe(true),
    );
    const target = (await fixture.inventory()).experiences.find(
      (entry) => entry.definition.id === 'write-brief',
    )!;
    const response = await fixture.routes.request('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { environment: { kind: 'current' }, agent: 'claude' },
        conversationId: 'experience-session',
        message: 'Write the reviewed brief',
        clientTurnId: 'brief-turn',
        skillExperience: {
          identity: target.identity,
          inputs: { idea: 'Use the agreed decisions' },
          expectedPreviousInvocationEventId: firstEvent.id,
        },
      }),
    });
    expect(
      response.status,
      JSON.stringify(await readJson(response.clone())),
    ).toBe(200);
    await vi.waitFor(() =>
      expect(
        fixture.store.listSkillExperienceEvents('experience-session'),
      ).toHaveLength(2),
    );
    expect(fixture.adapter.turns[1]!.input).toContain('BRIEF_STAGE_SENTINEL');
    expect(fixture.adapter.turns[1]!.threadId).not.toBe('experience-session');
    const child = fixture.adapter.turns[1]!.threadId;
    const view = await fixture.service.readSkillExperience(
      child,
      INTERNAL_SESSION_READ_SCOPE,
      undefined,
      1,
    );
    expect(view?.current?.threadId).toBe(child);
    expect(view?.current?.snapshot?.previousInvocationEventId).toBe(
      firstEvent.id,
    );
    expect(view?.hasMore).toBe(true);
    const older = await fixture.service.readSkillExperience(
      child,
      INTERNAL_SESSION_READ_SCOPE,
      view?.nextCursor,
      1,
    );
    expect(older?.history[0]?.eventId).toBe(firstEvent.id);
    expect(older?.current?.snapshot?.identity.experienceId).toBe('write-brief');
    const reference = view!.current!.reference!;
    await fixture.service.shutdown();
    fixture.store.deleteThread(child);
    expect(() =>
      fixture.store.createSkillExperienceSnapshots().read(reference),
    ).toThrow(/missing|corrupt/);
  } finally {
    await fixture.service.shutdown();
  }
});

test('reserved optional input identities produce an explicit definition-invalid inventory diagnostic', async () => {
  const fixture = await installedExperience((source) => {
    const file = join(
      source,
      'io.kontourai.station/experiences/stress-test-idea.json',
    );
    const definition = JSON.parse(readFileSync(file, 'utf8'));
    definition.inputs[0] = {
      ...definition.inputs[0],
      id: 'constructor',
      required: false,
      default: 'A declared default',
    };
    writeFileSync(file, JSON.stringify(definition));
  });
  await fixture.activate();
  expect(await fixture.inventory()).toMatchObject({
    experiences: [],
    diagnostics: [
      expect.objectContaining({
        code: 'definition-invalid',
        message: expect.stringContaining(
          'inputs/constructor: reserved input identity',
        ),
      }),
    ],
  });
});
