import { randomUUID } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { AgentExecutionConfig } from '@kontourai/station-contracts/agent';
import type { ConnectionRecoveryIntent } from '@kontourai/station-contracts/connection-recovery';
import type { ContributionConfig } from '@kontourai/station-contracts/contribution';
import type { Prerequisite } from '@kontourai/station-contracts/tool';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { awaitSessionRecoveryCompleted } from '../../../__test-utils__/session-runtime-barriers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import type {
  ProviderAdapterMetadata,
  ProviderSession,
  ProviderSessionStartInput,
} from '../../../providers/adapter-shape.js';
import { execGitSync } from '../../../utils/git-exec.js';
import { SkillService } from '../../agents/skill-service.js';
import { createRuntimeResourcePostureController } from '../../infra/resource-posture.js';
import { AgentPluginLoader } from '../../plugins/agent-plugin-loader.js';
import {
  pluginActivationDescriptorDigest,
  verifyPluginActivation,
} from '../../plugins/plugin-activation-plan.js';
import { computePluginContentDigest } from '../../plugins/plugin-content-integrity.js';
import { createLocalPluginInstallationService } from '../../plugins/plugin-installation-local.js';
import { readPluginManifestFile } from '../../plugins/plugin-manifest-loader.js';
import {
  ProjectBindingsStore,
  projectBindingStorePath,
} from '../../projects/project-binding-store.js';
import {
  ProjectContributionService,
  receiverAdmittedCwd,
} from '../../projects/project-contribution-service.js';
import { ProjectManifestStore } from '../../projects/project-manifest-store.js';
import { ProjectResourceResolver } from '../../projects/project-resource-resolver.js';
import { createProjectSessionDirectoryResolver } from '../../projects/project-session-directory.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import type { RecoveryDispatchAdapter } from '../recovery-dispatch-adapter.js';

class RecoveryAdapter extends GateTestAdapter {
  override readonly metadata: ProviderAdapterMetadata = {
    displayName: 'Recovery fixture',
    description: 'Recovery provider-effect observer',
    capabilities: ['agent-runtime'],
    modelLaunch: {
      defaultAtStart: 'engine-selected' as const,
      omissionAtResume: 'engine-selected' as const,
      omissionPerTurn: 'engine-selected' as const,
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    },
  };
  getPrerequisites = vi.fn(async (): Promise<Prerequisite[]> => []);
  readonly sessions = new Map<string, ProviderSession>();
  override startSession = vi.fn(async (input: ProviderSessionStartInput) => {
    const session: ProviderSession = {
      ...(await super.startSession(input)),
      cwd: input.cwd,
      resumeCursor: input.resumeCursor ?? { cursor: 'retained-provider' },
    };
    this.sessions.set(input.threadId, session);
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      createdAt: new Date().toISOString(),
      method: 'session.started',
      metadata: input.metadata,
    });
    return session;
  });
  override sendTurn = vi.fn(super.sendTurn);
  override async hasSession(threadId?: string) {
    return threadId !== undefined && this.sessions.has(threadId);
  }
  override async listSessions() {
    return [...this.sessions.values()];
  }
  override async stopSession(threadId?: string) {
    if (threadId !== undefined) this.sessions.delete(threadId);
  }
  override async stopAll() {
    this.sessions.clear();
  }
}

function pause() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    wait: async () => {
      enter();
      await released;
    },
  };
}

describe('retained Project authority at recovery provider effects', () => {
  const makeTempDir = trackTempDirs();
  const runtimes: OrchestrationService[] = [];
  const stores: EventStore[] = [];
  const pauses: ReturnType<typeof pause>[] = [];
  const configs: ConfigLoader[] = [];
  afterEach(async () => {
    for (const held of pauses.splice(0)) held.release();
    for (const runtime of runtimes.splice(0)) await runtime.shutdown();
    for (const store of stores.splice(0)) store.close();
    for (const config of configs.splice(0)) {
      config.dispose();
      await config.whenWatcherClosed();
    }
    vi.restoreAllMocks();
  });

  async function fixture(
    identity: 'qualified' | 'refused' = 'qualified',
    portable = false,
  ) {
    const home = realpathSync(makeTempDir('station-retained-recovery-'));
    const bound = join(home, 'bound');
    const replacement = join(home, 'replacement');
    const remote = 'https://github.com/example/retained-recovery.git';
    for (const path of [bound, replacement]) {
      mkdirSync(path);
      execGitSync(['init', path]);
      execGitSync(['remote', 'add', 'origin', remote], { cwd: path });
    }
    const storage = new FileStorageAdapter(home);
    const project = {
      id: randomUUID(),
      slug: 'retained',
      name: 'Retained',
      workingDirectory: replacement,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await storage.createProject(project);
    const manifests = new ProjectManifestStore(home, storage);
    await manifests.ensureProjectManifest(project);
    const manifest = manifests.readProjectManifest(project.slug);
    if (!manifest) throw new Error('Missing fixture manifest');
    const bindings = new ProjectBindingsStore(home);
    const bind = (path: string) =>
      bindings.upsertProjectBinding({
        projectId: manifest.id,
        resourceId: manifest.repos[0].id,
        kind: 'git-checkout',
        path,
        remotes: [remote],
        verifiedAt: Date.now(),
        state: 'bound',
      });
    await bind(bound);
    const config = portable
      ? new ConfigLoader({ projectHomeDir: home })
      : undefined;
    if (config) configs.push(config);
    const contribution = config
      ? new ProjectContributionService({
          source: storage,
          manifests,
          bindings,
          resolver: new ProjectResourceResolver({
            homeDir: home,
            source: storage,
            manifests,
            bindings,
          }),
          config,
        })
      : undefined;
    let offer: ContributionConfig | null = null;
    const setReceiverOffer = async (enabled: boolean) => {
      if (!contribution) throw new Error('Portable fixture was not requested.');
      offer = await contribution.setExecutionOffer(
        {
          portableProjectId: manifest.id,
          localProjectId: project.id,
          resourceId: manifest.repos[0].id,
          expected: offer,
          enabled,
        },
        () => true,
      );
    };
    if (portable) await setReceiverOffer(true);
    const store = new EventStore(join(home, 'orchestration.sqlite'));
    stores.push(store);
    const engine = new RecoveryAdapter();
    const agentPreparation = vi.fn(
      async (input: ProviderSessionStartInput) => input,
    );
    const defaultApproval = vi.fn(async () => undefined);
    const credentials = vi.fn(
      async (): Promise<AgentExecutionConfig> => ({
        credentialProfileRef: 'server-owned-profile',
      }),
    );
    const capacity = createRuntimeResourcePostureController();
    const runtime = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(engine),
      eventBus: new EventBus(),
      eventStore: store,
      listProjects: () =>
        storage
          .listProjects()
          .map((p) => (identity === 'refused' ? { ...p, id: undefined } : p)),
      resolveProjectSessionDirectory: createProjectSessionDirectoryResolver(
        home,
        storage,
      ),
      resolveSessionAgent: agentPreparation,
      loadAgentExecutionConfig: credentials,
      resourcePosture: capacity,
      resolveStationDefaultApprovalMode: defaultApproval,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    runtimes.push(runtime);
    const threadId = randomUUID();
    const mintReceiverAdmission = async () => {
      if (!contribution) throw new Error('Portable fixture was not requested.');
      const captured = await contribution.authorizeReceiverExecution(
        {
          portableProjectId: manifest.id,
          resourceId: manifest.repos[0].id,
        },
        () => true,
      );
      return {
        recheck: captured.recheck,
        admitted: {
          threadId,
          projectSlug: captured.admittedProject.slug,
          cwd: receiverAdmittedCwd(captured.admittedProject),
          portableProjectId: captured.portableProjectId,
          resourceId: captured.resourceId,
          localProjectId: captured.admittedProject.localProjectId,
        },
      };
    };
    const initialReceiver = portable
      ? await mintReceiverAdmission()
      : undefined;
    const initialInput = {
      threadId,
      provider: 'claude' as const,
      ...(initialReceiver ? { cwd: initialReceiver.admitted.cwd } : {}),
      metadata: {
        projectSlug: project.slug,
        executionAgentId: 'retained-agent',
      },
    };
    if (initialReceiver) {
      runtime.initialize();
      await awaitSessionRecoveryCompleted(runtime);
      const begun = await runtime.startSessionInternal(
        { type: 'start-session', input: initialInput },
        {},
        {
          receiverExecutionAdmission: initialReceiver,
          portableExecutionConsent: {
            portableProjectId: manifest.id,
            resourceId: manifest.repos[0].id,
            localProjectId: project.id,
          },
        },
      );
      expect(begun).toMatchObject({ status: 'accepted' });
    } else {
      await runtime.dispatch({ type: 'startSession', input: initialInput });
    }
    await vi.waitFor(() =>
      expect(runtime.firstStartedMetadataOfThread(threadId)).toMatchObject(
        identity === 'qualified'
          ? { localProjectId: project.id }
          : { localProjectIdRefused: true },
      ),
    );
    if (identity === 'qualified')
      expect(
        await runtime.authorizedConversationWorkspace(threadId),
      ).toMatchObject({ cwd: realpathSync(bound) });
    engine.startSession.mockClear();
    engine.sendTurn.mockClear();
    const revoke = async () => {
      await bind(replacement);
      // The original directory and Git identity survive; only current authority changed.
      expect(statSync(bound).isDirectory()).toBe(true);
      expect(
        execGitSync(['remote', 'get-url', 'origin'], { cwd: bound })
          .toString()
          .trim(),
      ).toBe(remote);
    };
    const revokeAtCapacity = () => {
      const reserve = capacity.reserveEngineStart.bind(capacity);
      vi.spyOn(capacity, 'reserveEngineStart').mockImplementationOnce(() => {
        const lease = reserve();
        // A valid operator edit at the final admission step; the resolver
        // still reads the real binding file and live checkout afterwards.
        const current = bindings.read();
        writeFileSync(
          projectBindingStorePath(home),
          JSON.stringify({
            ...current,
            bindings: current.bindings.map((binding) => ({
              ...binding,
              path: replacement,
            })),
          }),
        );
        return lease;
      });
    };
    const hold = () => {
      const held = pause();
      pauses.push(held);
      return held;
    };
    const recoveryDispatch = () => {
      // The coordinator uses this exact service-owned Adapter, including its profile branch.
      const adapter = (
        runtime as unknown as {
          createRecoveryDispatchAdapter(): RecoveryDispatchAdapter;
        }
      ).createRecoveryDispatchAdapter();
      const now = new Date().toISOString();
      const intent: ConnectionRecoveryIntent = {
        fingerprint: `${threadId}:source`,
        threadId,
        provider: 'claude',
        sourceEventId: 'source-event',
        sourceTurnId: 'source-turn',
        failureKind: 'capacity',
        scope: 'account',
        decision: 'retry-now',
        attempts: 0,
        maxAttempts: 1,
        outcome: 'armed',
        createdAt: now,
        updatedAt: now,
      };
      return adapter.dispatch({
        intent,
        credentialProfileRef: 'server-owned-profile',
        replay: {
          threadId,
          input: 'replay retained turn',
          recoveryCorrelationId: intent.fingerprint,
          signal: new AbortController().signal,
        },
      });
    };
    const dormant = async () => {
      // Copy the actual pre-shutdown durable records: a crash leaves these
      // resumable bytes, whereas graceful shutdown deliberately publishes exit.
      const snapshot = store.readSessionByThread(threadId);
      if (!snapshot) throw new Error('Missing started Session');
      const coldStore = new EventStore(join(home, 'cold-orchestration.sqlite'));
      stores.push(coldStore);
      for (const event of store.listEvents(threadId))
        coldStore.appendEvent(event.payload);
      coldStore.upsertSession(snapshot);
      await runtime.shutdown();
      runtimes.splice(runtimes.indexOf(runtime), 1);
      const coldEngine = new RecoveryAdapter();
      const cold = new OrchestrationService({
        adapterRegistry: createGateTestRegistry(coldEngine),
        eventBus: new EventBus(),
        eventStore: coldStore,
        listProjects: () => storage.listProjects(),
        resolveProjectSessionDirectory: createProjectSessionDirectoryResolver(
          home,
          storage,
        ),
        resolveSessionAgent: agentPreparation,
        loadAgentExecutionConfig: credentials,
        resourcePosture: capacity,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      runtimes.push(cold);
      cold.initialize();
      await awaitSessionRecoveryCompleted(cold);
      expect(coldEngine.startSession).not.toHaveBeenCalled();
      return { cold, coldEngine, coldStore };
    };
    const installExperience = async () => {
      const source = join(home, 'experience-source');
      cpSync(resolve('examples/visual-skill-experience'), source, {
        recursive: true,
      });
      const plugins = join(home, 'plugins');
      mkdirSync(plugins);
      const journal = store.createPackageMcpAdmissionJournal();
      const manifest = await readPluginManifestFile(
        join(source, 'plugin.json'),
      );
      const digest = computePluginContentDigest(
        dirname(source),
        basename(source),
      )!;
      await createLocalPluginInstallationService(
        plugins,
        journal,
        source,
      ).install({
        installation: manifest.name,
        expected: null,
        artifact: { digest },
        origin: 'b'.repeat(64),
        activationPlan: {
          version: 1,
          artifactDigest: digest,
          sourceDigest: digest,
          descriptorDigest: pluginActivationDescriptorDigest(manifest),
          origin: 'b'.repeat(64),
          consent: {
            kind: 'no-operator-decision',
            caller: 'retained-recovery-fixture',
          },
          previous: null,
          agents: [],
          ownedDependencies: [],
        },
      });
      const installed = journal.currentInstallation(manifest.name);
      if (installed.state !== 'observed')
        throw new Error('Missing Skill installation');
      const permit = journal.claimActivation(installed.installation);
      await verifyPluginActivation(permit, journal, async () => {});
      expect(journal.completeActivation(permit)).toEqual({ state: 'applied' });
      const loader = new AgentPluginLoader({
        projectHomeDir: home,
        journal: () => journal,
      });
      let admissionPause: ReturnType<typeof pause> | undefined;
      const skills = new SkillService(
        new ConfigLoader({ projectHomeDir: home }),
        { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
        {
          canonicalSources: () => loader.skillSources(),
          experienceInventory: () => loader.listSkillExperiences(),
          experienceSource: (identity, effect, permission) =>
            loader.withSkillExperience(
              identity,
              async (definition, content) => {
                // Hold the real installed-source lease before entering the service effect.
                await admissionPause?.wait();
                return effect(definition, content);
              },
              permission,
            ),
        },
      );
      await skills.discoverSkills(home);
      skills.enableExperienceExecution();
      expect(runtime.registerSkillExperienceSource(skills)).toBe(true);
      const inventory = await skills.listSkillExperiences();
      expect(inventory.diagnostics).toEqual([]);
      expect(inventory.experiences).toHaveLength(1);
      const send = engine.sendTurn.getMockImplementation()!;
      engine.sendTurn.mockImplementation(async (input) => {
        const accepted = { ...(await send(input)), turnId: randomUUID() };
        engine.events.push({
          eventId: randomUUID(),
          provider: engine.provider,
          threadId,
          turnId: accepted.turnId,
          method: 'turn.started',
          invocationId: input.invocationId,
          createdAt: new Date().toISOString(),
          metadata: input.metadata,
          prompt: input.displayInput ?? input.input,
        });
        engine.events.push({
          eventId: randomUUID(),
          provider: engine.provider,
          threadId,
          turnId: accepted.turnId,
          method: 'turn.completed',
          createdAt: new Date().toISOString(),
        });
        return accepted;
      });
      await runtime.dispatchWithReceipt(
        {
          type: 'sendTurn',
          input: {
            threadId,
            input: 'Start the experience',
            clientTurnId: randomUUID(),
          },
        },
        undefined,
        {
          skillExperience: {
            identity: inventory.experiences[0].identity,
            inputs: { idea: 'Retained Project safety' },
          },
        },
      );
      expect(engine.sendTurn).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(store.listSkillExperienceEvents(threadId)).toHaveLength(1);
        expect(
          store
            .listEvents(threadId)
            .some((event) => event.payload.method === 'turn.completed'),
        ).toBe(true);
      });
      engine.sendTurn.mockClear();
      return () => {
        admissionPause = hold();
        return admissionPause;
      };
    };
    return {
      runtime,
      engine,
      agentPreparation,
      defaultApproval,
      credentials,
      capacity,
      threadId,
      store,
      revoke,
      revokeAtCapacity,
      hold,
      recoveryDispatch,
      dormant,
      installExperience,
      setReceiverOffer,
      mintReceiverAdmission,
    };
  }

  test.each(['authorized', 'revoked'] as const)(
    'ordinary send after retained Skill admission keeps Project authority %s',
    async (authority) => {
      const f = await fixture();
      const holdAdmission = await f.installExperience();
      const held = holdAdmission();
      const sending = f.runtime
        .dispatch({
          type: 'sendTurn',
          input: { threadId: f.threadId, input: 'Continue the experience' },
        })
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      await Promise.race([
        held.entered,
        sending.then(() => {
          throw new Error('Send settled before real Skill source admission');
        }),
      ]);
      try {
        expect(f.engine.sendTurn).not.toHaveBeenCalled();
        if (authority === 'revoked') await f.revoke();
      } finally {
        held.release();
      }
      const outcome = await sending;
      expect(f.engine.startSession).not.toHaveBeenCalled();
      if (authority === 'revoked') {
        expect(f.engine.sendTurn).not.toHaveBeenCalled();
        expect(outcome).toMatchObject({
          error: {
            message: expect.stringContaining(
              'no longer an authorized Project resource',
            ),
          },
        });
      } else {
        expect(f.engine.sendTurn).toHaveBeenCalledTimes(1);
        expect(f.engine.sendTurn.mock.calls[0][0].input).toContain(
          'Retained Project safety',
        );
        expect(outcome).toMatchObject({
          result: { turnId: expect.any(String) },
        });
      }
    },
  );

  test('credential restart and direct replay succeed while the retained resource remains bound', async () => {
    const f = await fixture();
    expect(await f.recoveryDispatch()).toMatchObject({ kind: 'observed' });
    expect(f.engine.startSession).toHaveBeenCalledTimes(1);
    expect(f.engine.startSession.mock.calls[0][0]).toMatchObject({
      credentialProfileRef: 'server-owned-profile',
    });
    expect(f.engine.sendTurn).toHaveBeenCalledTimes(1);
  });

  test.each(['lazy send', 'explicit reattach'] as const)(
    'cold portable %s rechecks its real execution offer after Agent preparation',
    async (entry) => {
      const f = await fixture('qualified', true);
      const { cold, coldEngine, coldStore } = await f.dormant();
      const held = f.hold();
      f.agentPreparation.mockImplementationOnce(async (input) => {
        await held.wait();
        return input;
      });
      const receiver = await f.mintReceiverAdmission();
      const command =
        entry === 'lazy send'
          ? {
              type: 'sendTurn' as const,
              input: { threadId: f.threadId, input: 'portable continue' },
            }
          : {
              type: 'startSession' as const,
              input: { threadId: f.threadId, provider: 'claude' as const },
            };
      const recovering = cold.dispatch(command, undefined, {
        receiverExecutionAdmission: receiver,
      });
      void recovering.catch(() => {});
      try {
        await Promise.race([
          held.entered,
          recovering.then(() => {
            throw new Error(
              'Cold recovery skipped the held Agent preparation.',
            );
          }),
        ]);
        await f.setReceiverOffer(false);
        expect(coldEngine.startSession).not.toHaveBeenCalled();
        held.release();
        const refusal = await recovering.then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(coldEngine.startSession).not.toHaveBeenCalled();
        expect(coldEngine.sendTurn).not.toHaveBeenCalled();
        expect(refusal).toMatchObject({
          code: 'receiver_execution_not_offered',
          receipt: { status: 'rejected' },
          kind: 'permission_denied',
          failurePhase: 'refused',
          retryable: false,
        });
        expect(coldStore.readSessionByThread(f.threadId)).toMatchObject({
          resumeCursor: { cursor: 'retained-provider' },
        });
        expect(
          coldStore
            .listEvents(f.threadId)
            .filter((row) => row.payload.method === 'runtime.error')
            .at(-1)?.payload,
        ).toMatchObject({
          code: 'receiver_execution_not_offered',
          kind: 'permission_denied',
          failurePhase: 'refused',
          retryable: false,
          retriable: false,
        });
        await f.setReceiverOffer(true);
        await cold.dispatch(command, undefined, {
          receiverExecutionAdmission: await f.mintReceiverAdmission(),
        });
        expect(coldEngine.startSession).toHaveBeenCalledTimes(1);
        expect(coldEngine.sendTurn).toHaveBeenCalledTimes(
          entry === 'lazy send' ? 1 : 0,
        );
      } finally {
        held.release();
        await recovering.catch(() => undefined);
      }
    },
  );

  test.each([
    'before restart',
    'during restart preparation',
    'at capacity admission',
  ] as const)(
    'credential recovery refuses provider restart when revoked %s',
    async (timing) => {
      const f = await fixture();
      if (timing === 'at capacity admission') {
        f.revokeAtCapacity();
        await f.recoveryDispatch();
      } else if (timing === 'before restart') {
        await f.revoke();
        await f.recoveryDispatch();
      } else {
        const held = f.hold();
        f.agentPreparation.mockImplementationOnce(async (input) => {
          await held.wait();
          return input;
        });
        const recovering = f.recoveryDispatch();
        await Promise.race([
          held.entered,
          recovering.then(() => {
            throw new Error(
              'Recovery settled before the controlled preparation await',
            );
          }),
        ]);
        try {
          await f.revoke();
        } finally {
          held.release();
        }
        await recovering;
      }
      expect(f.engine.startSession).not.toHaveBeenCalled();
      expect(f.engine.sendTurn).not.toHaveBeenCalled();
      f.capacity.reserveEngineStart().release();
    },
  );

  test.each([
    'before replay preparation',
    'during replay preparation',
  ] as const)(
    'credential recovery refuses direct replay when revoked %s',
    async (timing) => {
      const f = await fixture();
      // A recorded Default makes both real posture resolutions consult the async owner.
      await f.runtime.dispatch({
        type: 'setApprovalMode',
        threadId: f.threadId,
        approvalMode: 'connection-default',
        basedOnSequence: null,
      });
      const held = f.hold();
      f.defaultApproval
        .mockImplementationOnce(async () => undefined)
        .mockImplementationOnce(async () => {
          await held.wait();
          return undefined;
        });
      if (timing === 'before replay preparation') {
        const start = f.engine.startSession.getMockImplementation()!;
        f.engine.startSession.mockImplementationOnce(async (input) => {
          const session = await start(input);
          await f.revoke();
          return session;
        });
      }
      const recovering = f.recoveryDispatch();
      await Promise.race([
        held.entered,
        recovering.then(() => {
          throw new Error(
            'Recovery settled before the controlled preparation await',
          );
        }),
      ]);
      try {
        expect(f.engine.startSession).toHaveBeenCalledTimes(1);
        if (timing === 'during replay preparation') await f.revoke();
      } finally {
        held.release();
      }
      await recovering;
      expect(f.engine.sendTurn).not.toHaveBeenCalled();
    },
  );

  test.each(['lazy send', 'explicit reattach'] as const)(
    'cold %s reaches the provider with an authorized retained resource',
    async (entry) => {
      const f = await fixture();
      const { cold, coldEngine } = await f.dormant();
      await cold.dispatch(
        entry === 'lazy send'
          ? {
              type: 'sendTurn',
              input: { threadId: f.threadId, input: 'continue' },
            }
          : {
              type: 'startSession',
              input: { threadId: f.threadId, provider: 'claude' },
            },
      );
      expect(coldEngine.startSession).toHaveBeenCalledTimes(1);
      expect(coldEngine.startSession.mock.calls[0][0]).toMatchObject({
        resumeCursor: { cursor: 'retained-provider' },
      });
      expect(coldEngine.sendTurn).toHaveBeenCalledTimes(
        entry === 'lazy send' ? 1 : 0,
      );
    },
  );

  test.each([
    ['lazy send', 'before request'],
    ['lazy send', 'readiness'],
    ['lazy send', 'agent'],
    ['lazy send', 'credentials'],
    ['lazy send', 'capacity admission'],
    ['explicit reattach', 'before request'],
    ['explicit reattach', 'readiness'],
    ['explicit reattach', 'agent'],
    ['explicit reattach', 'credentials'],
    ['explicit reattach', 'capacity admission'],
  ] as const)(
    'cold %s refuses provider start after revocation %s',
    async (entry, timing) => {
      const f = await fixture();
      const { cold, coldEngine, coldStore } = await f.dormant();
      const held = f.hold();
      if (timing === 'before request') await f.revoke();
      else if (timing === 'capacity admission') f.revokeAtCapacity();
      else if (timing === 'readiness')
        coldEngine.getPrerequisites.mockImplementationOnce(async () => {
          await held.wait();
          return [];
        });
      else if (timing === 'agent')
        f.agentPreparation.mockImplementationOnce(async (input) => {
          await held.wait();
          return input;
        });
      else
        f.credentials.mockImplementationOnce(async () => {
          await held.wait();
          return { credentialProfileRef: 'server-owned-profile' };
        });
      const recovering = cold
        .dispatch(
          entry === 'lazy send'
            ? {
                type: 'sendTurn',
                input: { threadId: f.threadId, input: 'continue' },
              }
            : {
                type: 'startSession',
                input: { threadId: f.threadId, provider: 'claude' },
              },
        )
        .catch((error: unknown) => error);
      if (timing !== 'before request' && timing !== 'capacity admission') {
        await Promise.race([
          held.entered,
          recovering.then(() => {
            throw new Error(
              'Recovery settled before the controlled preparation await',
            );
          }),
        ]);
        try {
          await f.revoke();
        } finally {
          held.release();
        }
      }
      const outcome = await recovering;
      expect(coldEngine.startSession).not.toHaveBeenCalled();
      expect(coldEngine.sendTurn).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({
        message: expect.stringContaining(
          'no longer an authorized Project resource',
        ),
      });
      expect(coldStore.readSessionByThread(f.threadId)).toMatchObject({
        resumeCursor: { cursor: 'retained-provider' },
      });
      f.capacity.reserveEngineStart().release();
    },
  );

  test('an originally refused Project identity cannot recover from its now-bound cwd', async () => {
    const f = await fixture('refused');
    await expect(
      f.runtime.authorizedConversationWorkspace(f.threadId),
    ).rejects.toThrow(/no verified Project identity/);
    await f.recoveryDispatch();
    expect(f.engine.startSession).not.toHaveBeenCalled();
    expect(f.engine.sendTurn).not.toHaveBeenCalled();
    const { cold, coldEngine } = await f.dormant();
    await expect(
      cold.dispatch({
        type: 'startSession',
        input: { threadId: f.threadId, provider: 'claude' },
      }),
    ).rejects.toThrow(/no verified Project identity/);
    expect(coldEngine.startSession).not.toHaveBeenCalled();
    expect(cold.firstStartedMetadataOfThread(f.threadId)).toMatchObject({
      localProjectIdRefused: true,
    });
    expect(cold.firstStartedMetadataOfThread(f.threadId)).not.toHaveProperty(
      'localProjectId',
    );
  });
});
