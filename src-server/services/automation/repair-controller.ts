import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTOMATION_EXECUTION_LIMITS,
  type AutomationActionIntent,
} from '@kontourai/station-contracts/automation';
import type { IsolatedRepairProjection } from '@kontourai/station-contracts/isolated-repair';
import {
  exactProcessIdentity,
  probeExactProcessIdentityAsync,
} from '@kontourai/station-shared/process-identity';
import type { Logger } from '../../utils/logger.js';
import type { TaskGraphService } from '../projects/task-graph-service.js';
import { sourceGrantsRuleAction } from './automation-config-validation.js';
import {
  automationConfigurationFingerprint,
  automationIntentMessage,
  automationPolicyFingerprint,
} from './automation-intent.js';
import type {
  AutomationActionReceipt,
  AutomationLedger,
} from './automation-ledger.js';
import type {
  AutomationStore,
  CreateAutomationRuleInput,
  CreateAutomationSourceInput,
} from './automation-store.js';
import { projectAutomationSource } from './automation-store.js';
import { materializeRepairCredential } from './repair-credentials.mjs';
import {
  publishRepair,
  type RepairPublicationLease,
  type RepairPublisherDependencies,
} from './repair-publisher.js';
import {
  collectRepairResult,
  prepareRepairSource,
  repairDigest,
} from './repair-source.js';
import {
  type RepairExecutionProfile,
  type RepairOperator,
  type RepairRun,
  RepairStore,
  repairProjection,
} from './repair-store.js';
import {
  executeDockerRepair,
  observeRepairWorker,
  type RepairWorkerEvidence,
  type RepairWorkerInput,
} from './repair-worker.mjs';

type RepairIntent = AutomationActionIntent & {
  action: Extract<
    AutomationActionIntent['action'],
    { kind: 'isolated-repair' }
  >;
};
function repairIntent(intent: AutomationActionIntent): intent is RepairIntent {
  return intent.action.kind === 'isolated-repair';
}
interface RepairControllerOptions {
  home: string;
  enabled(): boolean;
  policy: Pick<
    AutomationStore,
    'read' | 'createSource' | 'createRule' | 'listSources' | 'setEnabled'
  >;
  ledger(): AutomationLedger;
  tasks: Pick<
    TaskGraphService,
    'createTaskIdempotent' | 'readTaskView' | 'updateTaskStatus'
  >;
  projectRoot(projectId: string): string | undefined;
  isAgentCurrent(agentId: string): Promise<boolean>;
  logger: Pick<Logger, 'warn'>;
  worker?: (input: RepairWorkerInput) => Promise<RepairWorkerEvidence>;
  observeWorker?: typeof observeRepairWorker;
  publisher?: Pick<RepairPublisherDependencies, 'fetch'>;
}

/** One durable controller; neither Task completion nor review comments confer publication authority. */
export class IsolatedRepairController {
  readonly store: RepairStore;
  private readonly ownerId = randomUUID();
  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private readonly publishing = new Map<
    string,
    { id: string; done: Promise<void> }
  >();
  private busy = false;
  private closed = false;
  constructor(private readonly options: RepairControllerOptions) {
    this.store = new RepairStore(options.home);
  }

  automationConfiguration() {
    const configuration = this.options.policy.read();
    return {
      sources: configuration.sources.map(projectAutomationSource),
      rules: configuration.rules,
      fingerprint: automationConfigurationFingerprint(configuration),
    };
  }
  private async assertSetup(operator: RepairOperator) {
    await operator.assertCurrent();
    if (!this.enabled()) throw new Error('repair-authority-unavailable');
  }
  async createSource(
    input: CreateAutomationSourceInput,
    operator: RepairOperator,
  ) {
    await this.assertSetup(operator);
    return this.options.policy.createSource(input, () =>
      this.assertSetup(operator),
    );
  }
  async createRule(input: CreateAutomationRuleInput, operator: RepairOperator) {
    await this.assertSetup(operator);
    return this.options.policy.createRule(input, () =>
      this.assertSetup(operator),
    );
  }
  async enableAutomation(
    input: Parameters<AutomationStore['setEnabled']>[0],
    operator: RepairOperator,
  ) {
    const assertCurrent = () =>
      input.enabled ? this.assertSetup(operator) : operator.assertCurrent();
    await assertCurrent();
    await this.options.policy.setEnabled(input, assertCurrent);
  }

  enabled(): boolean {
    return !this.closed && this.options.enabled();
  }

  private current(
    run: RepairRun,
    allowReviewed = false,
  ): RepairExecutionProfile {
    if (this.closed || !this.options.enabled() || !repairIntent(run.intent))
      throw new Error('repair-authority-unavailable');
    const intent = run.intent;
    const currentIntent = this.options.ledger().readIntent(intent.intentId);
    if (
      !currentIntent ||
      currentIntent.policyFingerprint !== intent.policyFingerprint ||
      currentIntent.taskId !== run.taskId ||
      currentIntent.taskCreatedAt !== run.taskIncarnation ||
      ['refused', 'failed'].includes(currentIntent.state)
    )
      throw new Error('repair-intent-changed');
    const config = this.options.policy.read();
    const source = config.sources.find((s) => s.id === intent.sourceId);
    const rule = config.rules.find((r) => r.id === intent.ruleId);
    const task = this.options.tasks.readTaskView(run.taskId);
    const profile = this.store.execution(run.profileId);
    const occurredAt = Date.parse(intent.event.occurredAt);
    const fields = intent.event.fields;
    if (
      !source ||
      !rule?.enabled ||
      rule.action.kind !== 'isolated-repair' ||
      !rule.episode ||
      !sourceGrantsRuleAction(source, rule) ||
      automationPolicyFingerprint(source, rule) !== intent.policyFingerprint ||
      automationPolicyFingerprint(source, {
        ...rule,
        action: intent.action,
      }) !== intent.policyFingerprint ||
      source.repository !== fields.repository ||
      fields['run.head_repository'] !== source.repository ||
      !['push', 'schedule', 'workflow_dispatch'].includes(
        fields['run.event'],
      ) ||
      fields['run.head_branch'] !== 'main' ||
      !['failure', 'timed_out'].includes(fields['run.conclusion']) ||
      !Number.isFinite(occurredAt) ||
      occurredAt > Date.now() ||
      occurredAt < Date.now() - AUTOMATION_EXECUTION_LIMITS.maxEventAgeMs ||
      this.options.ledger().episode(intent.episodeKey)?.episodeId !==
        intent.episodeId ||
      !task ||
      task.createdAt !== run.taskIncarnation ||
      task.projectId !== intent.action.projectId ||
      task.status === 'canceled' ||
      (task.status === 'done' && !allowReviewed) ||
      !this.options.projectRoot(intent.action.projectId) ||
      !profile?.enabled ||
      profile.projectId !== intent.action.projectId ||
      profile.agentId !== intent.action.agentId ||
      profile.repository !== source.repository ||
      repairDigest(profile) !== run.profileDigest
    )
      throw new Error('repair-authority-changed');
    return profile;
  }
  private async assertCurrent(run: RepairRun, allowReviewed = false) {
    const profile = this.current(run, allowReviewed);
    if (!(await this.options.isAgentCurrent(profile.agentId)))
      throw new Error('repair-agent-unavailable');
    this.current(run, allowReviewed);
  }
  private identity(run: RepairRun) {
    return {
      containerName: run.containerName,
      runId: run.runId,
      ownerId: run.ownerId,
    };
  }
  private temporary(run: RepairRun) {
    return join(realpathSync(tmpdir()), `station-isolated-repair-${run.runId}`);
  }
  private async cleanup(run: RepairRun) {
    const path = this.temporary(run);
    try {
      if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
        throw new Error('unsafe');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('repair-cleanup-unverified');
    }
    const marker = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
    if (marker.ownerId !== run.ownerId || marker.runId !== run.runId)
      throw new Error('repair-cleanup-unverified');
    await rm(path, { recursive: true });
  }
  private get(runId: string): RepairRun {
    const run = this.store.read(runId);
    if (!run) throw new Error('repair-not-found');
    return run;
  }
  list(): IsolatedRepairProjection[] {
    return this.store.list().map((r) => repairProjection(r));
  }
  async artifact(runId: string, operator: RepairOperator) {
    await operator.assertCurrent();
    const run = this.get(runId);
    const task = this.options.tasks.readTaskView(run.taskId);
    if (
      !task ||
      task.createdAt !== run.taskIncarnation ||
      task.projectId !== run.intent.action.projectId
    )
      throw new Error('repair-task-changed');
    await operator.assertCurrent();
    const evidence = this.store.evidence(runId);
    if (
      run.workerReceiptDigest &&
      (evidence === undefined ||
        repairDigest(evidence) !== run.workerReceiptDigest)
    )
      throw new Error('repair-evidence-integrity');
    return {
      ...repairProjection(run),
      workerEvidence: evidence,
      followup: run.followup,
      priorGrants: run.priorGrants,
      admissionReleasedAt: run.admissionReleasedAt,
      source: run.source,
      result: run.result,
      workerReceiptDigest: run.workerReceiptDigest,
      review: run.review,
      grant: run.grant,
      checkpoints: run.checkpoints,
      publication: run.publication,
    };
  }

  async tick(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      for (const run of this.store.list()) {
        if (
          ['planned', 'executing', 'publishing'].includes(run.phase) &&
          !this.active.has(run.runId) &&
          !this.publishing.has(run.runId)
        )
          await this.recover(run);
      }
      if (!this.options.enabled()) return;
      const ledger = this.options.ledger();
      for (const intent of ledger.listActionIntents()) {
        if (
          !repairIntent(intent) ||
          intent.state !== 'pending' ||
          this.active.size >= 2 ||
          this.store
            .list()
            .some((run) => run.intent.intentId === intent.intentId)
        )
          continue;
        const config = this.options.policy.read();
        const rule = config.rules.find((r) => r.id === intent.ruleId);
        if (rule?.action.kind !== 'isolated-repair') continue;
        const claim = ledger.claimAction({
          episodeKey: intent.episodeKey,
          expectedEpisodeId: intent.episodeId,
          deliveryKey: intent.deliveryKey,
          now: Date.now(),
          maxStartsPerHour: rule.rateLimit.maxStartsPerHour,
          maxConcurrentActions:
            AUTOMATION_EXECUTION_LIMITS.maxConcurrentActions,
        });
        if (claim.kind !== 'claimed') continue;
        try {
          await this.start(intent, claim.receipt);
        } catch {
          claim.receipt.release();
          if (ledger.readIntent(intent.intentId)?.state === 'pending')
            ledger.updateIntent(
              intent.intentId,
              { state: 'refused', reason: 'isolated_repair_admission_refused' },
              Date.now(),
            );
        }
      }
    } catch {
      this.options.logger.warn('Isolated repairs are unavailable');
    } finally {
      this.busy = false;
    }
  }
  private async start(intent: RepairIntent, claim: AutomationActionReceipt) {
    const profile = this.store.execution(intent.action.profileId);
    const owner = exactProcessIdentity(process.pid);
    if (!profile || !owner)
      throw new Error('repair-profile-or-owner-unavailable');
    const task = await this.options.tasks.createTaskIdempotent(
      {
        projectId: intent.action.projectId,
        agentId: intent.action.agentId,
        title: 'Review isolated GitHub repair',
        description: automationIntentMessage(intent),
        createdBy: 'automation-rule',
      },
      'automation-rule',
      intent.intentId,
    );
    this.options
      .ledger()
      .updateIntent(
        intent.intentId,
        { taskId: task.id, taskCreatedAt: task.createdAt },
        Date.now(),
      );
    const runId = randomUUID();
    let run = await this.store.create({
      version: 1,
      runId,
      revision: 1,
      phase: 'planned',
      intent,
      taskId: task.id,
      taskIncarnation: task.createdAt,
      profileId: profile.id,
      profileDigest: repairDigest(profile),
      owner,
      ownerId: this.ownerId,
      containerName: `kontour-worker-${runId}`,
      createdAt: new Date().toISOString(),
      checkpoints: [],
      priorGrants: [],
    });
    if (run.ownerId !== this.ownerId || run.phase !== 'planned')
      throw new Error('repair-existing-attempt');
    let invoked = false;
    try {
      await this.assertCurrent(run);
      // Persist invocation custody before source preparation, credentials, or Docker effects.
      if (claim.beginInvocation(Date.now()) !== 'applied')
        throw new Error('repair-claim-stale');
      invoked = true;
      run = await this.store.change(runId, run.revision, (r) => ({
        ...r,
        phase: 'executing',
      }));
    } catch {
      const current = this.get(runId);
      await this.store.change(runId, current.revision, (r) => ({
        ...r,
        phase: invoked ? 'indeterminate' : 'canceled',
        reasonCode: invoked
          ? 'repair-invocation-unconfirmed'
          : 'repair-admission-refused',
      }));
      if (invoked) {
        this.options.ledger().updateIntent(
          intent.intentId,
          {
            state: 'indeterminate',
            reason: 'isolated_repair_invocation_unconfirmed',
          },
          Date.now(),
        );
        claim.settle({
          state: 'indeterminate',
          now: Date.now(),
          taskId: run.taskId,
        });
      }
      throw new Error('repair-admission-refused');
    }
    const controller = new AbortController();
    const promise = this.execute(run, profile, controller, claim).finally(
      () => {
        this.active.delete(runId);
      },
    );
    this.active.set(runId, { controller, promise });
  }
  private async execute(
    run: RepairRun,
    profile: RepairExecutionProfile,
    controller: AbortController,
    claim: AutomationActionReceipt,
  ): Promise<void> {
    if (!repairIntent(run.intent)) throw new Error('repair-action');
    const action = run.intent.action;
    const deadline = Date.now() + action.budget.maxWallRuntimeMs;
    const assertCurrent = async () => {
      if (controller.signal.aborted || Date.now() >= deadline)
        throw new Error('repair-execution-stopped');
      await this.assertCurrent(run);
      if (controller.signal.aborted || Date.now() >= deadline)
        throw new Error('repair-execution-stopped');
    };
    let checking = false;
    const timer = setInterval(() => {
      if (Date.now() >= deadline) controller.abort();
      if (checking) return;
      checking = true;
      void assertCurrent()
        .catch(() => controller.abort())
        .finally(() => {
          checking = false;
        });
    }, 1000);
    try {
      await this.options.tasks.updateTaskStatus(run.taskId, 'in_progress');
      await assertCurrent();
      const directory = this.temporary(run);
      await mkdir(directory, { mode: 0o700 });
      await writeFile(
        join(directory, 'owner.json'),
        JSON.stringify({ runId: run.runId, ownerId: run.ownerId }),
        { flag: 'wx', mode: 0o400 },
      );
      const projectRoot = this.options.projectRoot(action.projectId);
      if (!projectRoot) throw new Error('repair-project-unavailable');
      const sourceRoot = join(directory, 'source');
      const workspace = join(directory, 'workspace');
      const source = await prepareRepairSource({
        projectRoot,
        repository: profile.repository,
        sourceRoot,
        workspace,
        assertCurrent: () => {
          this.current(run);
          if (controller.signal.aborted || Date.now() >= deadline)
            throw new Error('repair-execution-stopped');
        },
      });
      const bindingDigest = repairDigest({
        executionId: run.runId,
        taskId: run.taskId,
        taskIncarnation: run.taskIncarnation,
        intentId: run.intent.intentId,
        policyFingerprint: run.intent.policyFingerprint,
        episodeKey: run.intent.episodeKey,
        episodeId: run.intent.episodeId,
        workflowRun: run.intent.event.fields['run.id'],
        workflowAttempt: run.intent.event.fields['run.run_attempt'],
        failedSha: run.intent.event.fields['run.head_sha'],
        repository: profile.repository,
        repositoryId: profile.repositoryId,
        profileDigest: run.profileDigest,
        sourceDigest: source.digest,
        baseSha: source.baseSha,
        baseTreeSha: source.baseTreeSha,
      });
      run = await this.store.change(run.runId, run.revision, (r) => ({
        ...r,
        source,
        bindingDigest,
      }));
      await assertCurrent();
      const evidence = await (this.options.worker ?? executeDockerRepair)({
        ...this.identity(run),
        home: this.options.home,
        profile,
        directory,
        workspace,
        sourceRoot,
        bindingDigest,
        instructions: action.instructions,
        observation: run.intent.event.fields,
        budget: {
          ...action.budget,
          maxWallRuntimeMs: Math.max(1, deadline - Date.now()),
        },
        signal: controller.signal,
        assertCurrent,
      });
      await (this.options.observeWorker ?? observeRepairWorker)(
        this.identity(run),
      );
      await assertCurrent();
      const receipt = evidence.receipt;
      if (
        !receipt.container_removed ||
        receipt.storage_violation ||
        receipt.terminal.status !== 0 ||
        receipt.terminal.timeout ||
        receipt.terminal.overflow ||
        !receipt.provider_thread_id ||
        receipt.observed.execution_owner !== run.ownerId ||
        receipt.observed.invocation_id !== run.runId ||
        receipt.observed.image !== profile.image ||
        receipt.observed.argv_model !== profile.model ||
        receipt.observed.host_setup?.station_repair_binding !== bindingDigest ||
        evidence.provider.counters.total_forwarded >
          action.budget.maxProviderRequests
      )
        throw new Error('repair-execution-unqualified');
      const result = await collectRepairResult(source, sourceRoot, workspace);
      await assertCurrent();
      const retained = this.store.directory(run.runId);
      await mkdir(retained, { mode: 0o700 });
      await writeFile(
        join(retained, 'worker-evidence.json'),
        JSON.stringify(evidence),
        { flag: 'wx', mode: 0o600 },
      );
      run = await this.store.change(run.runId, run.revision, (r) => ({
        ...r,
        phase: 'proposed',
        result,
        workerReceiptDigest: repairDigest(evidence),
        completedAt: new Date().toISOString(),
      }));
      this.options
        .ledger()
        .updateIntent(run.intent.intentId, { state: 'completed' }, Date.now());
      claim.settle({ state: 'completed', now: Date.now(), taskId: run.taskId });
      await this.options.tasks.updateTaskStatus(run.taskId, 'review');
      try {
        await this.cleanup(run);
      } catch {
        const current = this.get(run.runId);
        await this.store.change(current.runId, current.revision, (r) => ({
          ...r,
          reasonCode: 'repair-cleanup-pending',
        }));
      }
    } catch (error) {
      controller.abort();
      const reasonCode =
        error instanceof Error && /^repair-[a-z-]+$/.test(error.message)
          ? error.message
          : 'repair-execution-unconfirmed';
      let stopped = false;
      try {
        await (this.options.observeWorker ?? observeRepairWorker)(
          this.identity(run),
        );
        stopped = true;
      } catch {
        /* Preserve unknown workers and their workspace for owned recovery. */
      }
      try {
        const current = this.get(run.runId);
        if (current.phase === 'executing')
          await this.store.change(current.runId, current.revision, (r) => ({
            ...r,
            phase: 'indeterminate',
            reasonCode: stopped ? reasonCode : 'repair-worker-stop-unverified',
          }));
        this.options
          .ledger()
          .updateIntent(
            run.intent.intentId,
            { state: 'indeterminate', reason: 'isolated_repair_unconfirmed' },
            Date.now(),
          );
        claim.settle({
          state: 'indeterminate',
          now: Date.now(),
          taskId: run.taskId,
        });
        if (stopped) await this.cleanup(run);
      } catch {
        this.options.logger.warn(
          'Isolated repair recovery requires operator attention',
        );
      }
    } finally {
      clearInterval(timer);
    }
  }
  private async recover(run: RepairRun) {
    const expectedOwner =
      run.phase === 'publishing' ? run.publicationAttempt?.owner : run.owner;
    if (!expectedOwner) throw new Error('repair-publication-owner-unavailable');
    const owner = await probeExactProcessIdentityAsync(expectedOwner.pid);
    if (
      owner.state === 'unavailable' ||
      (owner.state === 'exact' && owner.identity.start === expectedOwner.start)
    )
      return;
    await (this.options.observeWorker ?? observeRepairWorker)(
      this.identity(run),
      { remove: true },
    );
    await this.store.change(run.runId, run.revision, (r) => ({
      ...r,
      phase: 'indeterminate',
      reasonCode:
        r.phase === 'publishing'
          ? 'publication-reconciliation-required'
          : 'repair-owner-ended',
    }));
    this.options
      .ledger()
      .updateIntent(
        run.intent.intentId,
        { state: 'indeterminate', reason: 'isolated_repair_owner_ended' },
        Date.now(),
      );
    await this.cleanup(run);
  }
  async review(
    runId: string,
    input: {
      bindingDigest: string;
      resultDigest: string;
      verdict: 'approve' | 'reject';
      rationale: string;
    },
    operator: RepairOperator,
  ) {
    const run = this.get(runId);
    await operator.assertCurrent();
    await this.assertCurrent(run, true);
    if (
      run.phase !== 'proposed' ||
      !run.result ||
      run.bindingDigest !== input.bindingDigest ||
      run.result.digest !== input.resultDigest ||
      !input.rationale.trim() ||
      input.rationale.length > 4096
    )
      throw new Error('repair-review-conflict');
    await (this.options.observeWorker ?? observeRepairWorker)(
      this.identity(run),
    );
    const next = await this.store.change(
      runId,
      run.revision,
      async (current) => {
        await operator.assertCurrent();
        await this.assertCurrent(current, true);
        return {
          ...current,
          phase: input.verdict === 'approve' ? 'reviewed' : 'rejected',
          review: {
            id: randomUUID(),
            ...input,
            operatorId: operator.id,
            at: new Date().toISOString(),
          },
        };
      },
    );
    await this.options.tasks.updateTaskStatus(
      run.taskId,
      input.verdict === 'approve' ? 'done' : 'blocked',
    );
    return repairProjection(next);
  }
  private publicationAuthority(run: RepairRun) {
    const execution = this.current(run, true);
    if (
      !run.result ||
      !run.source ||
      !run.bindingDigest ||
      run.review?.verdict !== 'approve' ||
      run.review.bindingDigest !== run.bindingDigest ||
      run.review.resultDigest !== run.result.digest ||
      this.options.tasks.readTaskView(run.taskId)?.status !== 'done'
    )
      throw new Error('repair-review-required');
    const source = this.options.policy
      .read()
      .sources.find((s) => s.id === run.intent.sourceId);
    if (
      !source?.grants?.some(
        (grant) =>
          grant.projectId === execution.projectId &&
          grant.agentId === execution.agentId &&
          grant.actions.includes('publish-branch'),
      )
    )
      throw new Error('repair-publication-source-grant-required');
    const { digest: resultDigest, ...result } = run.result;
    const { digest: sourceDigest, ...sourceSnapshot } = run.source;
    if (
      repairDigest(result) !== resultDigest ||
      repairDigest(sourceSnapshot) !== sourceDigest
    )
      throw new Error('repair-artifact-integrity');
    return execution;
  }
  async grant(
    runId: string,
    input: {
      bindingDigest: string;
      resultDigest: string;
      reviewId: string;
      publisherId: string;
    },
    operator: RepairOperator,
  ) {
    const run = this.get(runId);
    await operator.assertCurrent();
    const execution = this.publicationAuthority(run);
    const publisher = this.store.publisher(input.publisherId);
    if (
      run.phase !== 'reviewed' ||
      input.bindingDigest !== run.bindingDigest ||
      input.resultDigest !== run.result!.digest ||
      input.reviewId !== run.review!.id ||
      !publisher?.enabled ||
      publisher.repository !== execution.repository ||
      publisher.repositoryId !== execution.repositoryId
    )
      throw new Error('repair-publication-grant-conflict');
    await (this.options.observeWorker ?? observeRepairWorker)(
      this.identity(run),
    );
    const next = await this.store.change(
      runId,
      run.revision,
      async (current) => {
        await operator.assertCurrent();
        this.publicationAuthority(current);
        return {
          ...current,
          phase: 'granted',
          priorGrants: current.grant
            ? [...current.priorGrants, current.grant]
            : current.priorGrants,
          grant: {
            id: randomUUID(),
            reviewId: current.review!.id,
            resultDigest: current.result!.digest,
            bindingDigest: current.bindingDigest!,
            publisherId: publisher.id,
            publisherDigest: repairDigest(publisher),
            operatorId: operator.id,
            expiresAt: Date.now() + 15 * 60_000,
          },
        };
      },
    );
    return next.grant!;
  }
  async revoke(runId: string, operator: RepairOperator) {
    const run = this.get(runId);
    await operator.assertCurrent();
    await this.store.change(runId, run.revision, async (r) => {
      await operator.assertCurrent();
      return {
        ...r,
        phase:
          r.phase === 'granted' && !r.grant?.consumedAt ? 'reviewed' : r.phase,
        grant: r.grant ? { ...r.grant, revokedAt: Date.now() } : undefined,
      };
    });
  }
  async publish(runId: string, grantId: string, operator: RepairOperator) {
    let run = this.get(runId);
    await operator.assertCurrent();
    const execution = this.publicationAuthority(run);
    const grant = run.grant;
    const publisher = grant
      ? this.store.publisher(grant.publisherId)
      : undefined;
    if (
      run.phase !== 'granted' ||
      !grant ||
      grant.id !== grantId ||
      grant.consumedAt ||
      grant.revokedAt ||
      grant.expiresAt <= Date.now() ||
      !publisher?.enabled ||
      repairDigest(publisher) !== grant.publisherDigest
    )
      throw new Error('repair-publication-grant-unavailable');
    const operationId = randomUUID();
    const publicationOwner = exactProcessIdentity(process.pid);
    if (!publicationOwner)
      throw new Error('repair-publication-owner-unavailable');
    let ownsOperation = false;
    let operationActive = true;
    let beginAttempted = false;
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const assertCurrent = async () => {
      if (!operationActive) throw new Error('repair-publication-ended');
      await operator.assertCurrent();
      if (!operationActive) throw new Error('repair-publication-ended');
      const current = this.get(runId);
      this.publicationAuthority(current);
      const currentPublisher = this.store.publisher(publisher.id);
      if (
        !['granted', 'publishing'].includes(current.phase) ||
        current.grant?.id !== grantId ||
        current.grant.revokedAt ||
        current.grant.expiresAt <= Date.now() ||
        current.review?.id !== grant.reviewId ||
        current.bindingDigest !== grant.bindingDigest ||
        current.result?.digest !== grant.resultDigest ||
        !currentPublisher?.enabled ||
        repairDigest(currentPublisher) !== grant.publisherDigest
      )
        throw new Error('repair-publication-authority-changed');
      if (
        current.phase === 'publishing' &&
        (!ownsOperation || current.publicationAttempt?.id !== operationId)
      )
        throw new Error('repair-publication-operation-changed');
      await (this.options.observeWorker ?? observeRepairWorker)(
        this.identity(run),
      );
      await operator.assertCurrent();
      if (!operationActive) throw new Error('repair-publication-ended');
    };
    const lease: RepairPublicationLease = {
      assertCurrent,
      begin: async () => {
        await assertCurrent();
        beginAttempted = true;
        try {
          run = await this.store.change(runId, run.revision, async (r) => {
            await operator.assertCurrent();
            this.publicationAuthority(r);
            if (!operationActive) throw new Error('repair-publication-ended');
            if (
              r.phase !== 'granted' ||
              r.grant?.id !== grantId ||
              r.grant.consumedAt ||
              r.grant.revokedAt ||
              r.grant.expiresAt <= Date.now()
            )
              throw new Error('repair-publication-consumed');
            return {
              ...r,
              phase: 'publishing',
              publicationAttempt: {
                id: operationId,
                owner: publicationOwner,
                ownerId: this.ownerId,
              },
              grant: { ...r.grant, consumedAt: Date.now() },
            };
          });
          if (!operationActive) return false;
          ownsOperation = true;
          this.publishing.set(runId, { id: operationId, done });
          return true;
        } catch (error) {
          const current = this.get(runId);
          if (current.publicationAttempt?.id !== operationId) return false;
          throw error;
        }
      },
      checkpoint: async (checkpoint) => {
        const current = this.get(runId);
        run = await this.store.change(runId, current.revision, async (r) => {
          await operator.assertCurrent();
          if (
            !operationActive ||
            r.phase !== 'publishing' ||
            r.publicationAttempt?.id !== operationId ||
            r.grant?.id !== grantId ||
            r.grant.revokedAt
          )
            throw new Error('repair-publication-revoked');
          return { ...r, checkpoints: [...r.checkpoints, checkpoint] };
        });
      },
      finish: async (receipt) => {
        await assertCurrent();
        const current = this.get(runId);
        run = await this.store.change(runId, current.revision, (r) => {
          if (
            !operationActive ||
            r.phase !== 'publishing' ||
            r.publicationAttempt?.id !== operationId ||
            r.grant?.revokedAt
          )
            throw new Error('repair-publication-operation-changed');
          return { ...r, phase: 'published', publication: receipt };
        });
      },
      indeterminate: async (reasonCode) => {
        const current = this.get(runId);
        if (
          (current.phase === 'publishing' &&
            current.publicationAttempt?.id === operationId) ||
          (beginAttempted &&
            current.phase === 'granted' &&
            current.grant?.id === grantId &&
            !current.grant.consumedAt)
        ) {
          run = await this.store.change(runId, current.revision, (r) => {
            if (
              r.phase === 'publishing' &&
              r.publicationAttempt?.id !== operationId
            )
              throw new Error('repair-publication-operation-changed');
            return {
              ...r,
              phase: 'indeterminate',
              reasonCode,
              publicationAttempt: r.publicationAttempt ?? {
                id: operationId,
                owner: publicationOwner,
                ownerId: this.ownerId,
              },
              grant: r.grant
                ? { ...r.grant, consumedAt: r.grant.consumedAt ?? Date.now() }
                : undefined,
            };
          });
        }
      },
    };
    const completedAt = new Date(
      Math.floor(Date.parse(run.completedAt!) / 1000) * 1000,
    ).toISOString();
    try {
      return await publishRepair(
        {
          runId,
          bindingDigest: run.bindingDigest!,
          resultDigest: run.result!.digest,
          taskIncarnation: run.taskIncarnation,
          repository: execution.repository,
          repositoryId: execution.repositoryId,
          failedRun: Number(run.intent.event.fields['run.id']),
          failedSha: run.intent.event.fields['run.head_sha'],
          episode: Number(run.intent.event.fields['run.id']),
          attempt: `${run.intent.event.fields['run.id']}-${run.intent.event.fields['run.run_attempt']}`,
          baseSha: run.source!.baseSha,
          baseTreeSha: run.source!.baseTreeSha,
          expectedTreeSha: run.result!.expectedTreeSha,
          files: run.result!.files,
          completedAt,
          appId: publisher.appId,
          installationId: publisher.installationId,
          reviewId: run.review!.id,
          grantId,
        },
        lease,
        {
          ...this.options.publisher,
          resolveAppPrivateKey: async () => {
            await assertCurrent();
            const privateKey = await materializeRepairCredential(
              publisher.privateKeyAuth,
              { assertCurrent },
            );
            await assertCurrent();
            return { privateKey, assertCurrent };
          },
        },
      );
    } finally {
      operationActive = false;
      if (this.publishing.get(runId)?.id === operationId)
        this.publishing.delete(runId);
      resolveDone();
    }
  }
  async followup(runId: string, rationale: string, operator: RepairOperator) {
    await operator.assertCurrent();
    const run = this.get(runId);
    if (
      run.phase !== 'indeterminate' ||
      !rationale.trim() ||
      rationale.length > 4096
    )
      throw new Error('repair-followup-conflict');
    await this.store.change(runId, run.revision, async (r) => {
      await operator.assertCurrent();
      return {
        ...r,
        followup: {
          rationale,
          operatorId: operator.id,
          at: new Date().toISOString(),
        },
      };
    });
    return {
      outcome: 'followup-recorded',
      publicationEffects: 'unverified',
      replay: 'refused',
    };
  }
  async cancel(runId: string, operator: RepairOperator) {
    await operator.assertCurrent();
    const run = this.get(runId);
    if (run.phase === 'publishing' || run.phase === 'indeterminate') {
      await this.store.change(runId, run.revision, async (r) => {
        await operator.assertCurrent();
        return {
          ...r,
          grant: r.grant ? { ...r.grant, revokedAt: Date.now() } : undefined,
          reasonCode: r.reasonCode ?? 'publication-cancellation-requested',
        };
      });
      await this.publishing.get(runId)?.done;
      return repairProjection(this.get(runId));
    }
    const active = this.active.get(runId);
    if (active) {
      active.controller.abort();
      await active.promise;
    } else if (['planned', 'executing', 'publishing'].includes(run.phase))
      await this.recover(run);
    else if (!['published', 'rejected', 'canceled'].includes(run.phase))
      await this.store.change(runId, run.revision, async (r) => {
        await operator.assertCurrent();
        return {
          ...r,
          phase: 'canceled',
          grant: r.grant ? { ...r.grant, revokedAt: Date.now() } : undefined,
        };
      });
  }
  async resolve(runId: string, rationale: string, operator: RepairOperator) {
    await operator.assertCurrent();
    const run = this.get(runId);
    if (
      run.phase !== 'indeterminate' ||
      this.active.has(runId) ||
      this.publishing.has(runId) ||
      !rationale.trim() ||
      rationale.length > 4096
    )
      throw new Error('repair-resolution-conflict');
    const owner = run.publicationAttempt ?? {
      owner: run.owner,
      ownerId: run.ownerId,
    };
    if (owner.ownerId !== this.ownerId) {
      const observed = await probeExactProcessIdentityAsync(owner.owner.pid);
      if (
        observed.state === 'unavailable' ||
        (observed.state === 'exact' &&
          observed.identity.start === owner.owner.start)
      )
        throw new Error('repair-owner-not-settled');
    }
    await (this.options.observeWorker ?? observeRepairWorker)(
      this.identity(run),
    );
    await this.store.change(runId, run.revision, async (r) => {
      await operator.assertCurrent();
      return {
        ...r,
        followup: {
          rationale,
          operatorId: operator.id,
          at: new Date().toISOString(),
        },
        grant: r.grant ? { ...r.grant, revokedAt: Date.now() } : undefined,
      };
    });
    await operator.assertCurrent();
    this.options
      .ledger()
      .updateIntent(
        run.intent.intentId,
        { state: 'failed', reason: 'isolated_repair_operator_resolved' },
        Date.now(),
      );
    const released = this.get(runId);
    await this.store.change(runId, released.revision, async (r) => {
      await operator.assertCurrent();
      return { ...r, admissionReleasedAt: new Date().toISOString() };
    });
    return {
      outcome: 'admission-released',
      publicationEffects: 'unverified',
      replay: 'refused',
    };
  }
  async archive(runId: string, operator: RepairOperator) {
    const run = this.get(runId);
    if (
      run.phase === 'indeterminate' &&
      this.options.ledger().readIntent(run.intent.intentId)?.state !== 'failed'
    )
      throw new Error('repair-admission-still-held');
    await operator.assertCurrent();
    await (this.options.observeWorker ?? observeRepairWorker)(
      this.identity(run),
    );
    await this.store.archive(runId, operator);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const { controller } of this.active.values()) controller.abort();
    await Promise.allSettled([
      ...[...this.active.values()].map((entry) => entry.promise),
      ...[...this.publishing.values()].map((entry) => entry.done),
    ]);
  }
}
