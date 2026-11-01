import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentFrame,
  type AgentJournal,
  type AgentTurnLease,
  agentWire,
  createAgentRuntime,
  type DurableApproval,
  listSqliteAgentTurns,
  openSqliteAgentJournal,
  type RunKey,
  readAgentWire,
  readSqliteAgentApprovals,
  readSqliteAgentFrame,
  readSqliteAgentFrames,
  readSqliteAgentTurn,
} from '@kontourai/agent-runtime';
import {
  type OwnerIdentity,
  ownerLivenessFromProbe,
} from '@kontourai/monument';
import type { VerifiedMcpPromptOrigin } from '@kontourai/station-contracts/mcp-prompts';
import {
  exactProcessIdentity,
  probeExactProcessIdentity,
} from '@kontourai/station-shared/process-identity';
import { z } from 'zod';
import type { FeaturePreviewSelector } from '../../services/feature-previews/feature-preview-registry.js';
import type { DurableTurnHandoff } from '../../services/orchestration/interrupted-turn-recovery.js';
import { openPrivateSqlite } from '../../utils/private-sqlite.js';
import {
  type AuthorizedTurnCorrelation,
  currentAuthorizedTurnCorrelation,
  currentMcpPromptOrigin,
} from '../conversation/authorized-turn-correlation.js';
import { currentNativeExecutionWorkspace } from '../conversation/native-execution-workspace.js';
import {
  captureDurableNativeOutputFacts,
  type DurableNativeOutputFacts,
  isDurableNativeOutputFacts,
} from '../native-output-turn-grant.js';
import type { IStreamChunk, IStreamResult } from '../types.js';
import {
  DurableForegroundChannel,
  encodeDurableAgentFrame,
  registerDurableForeground,
} from './durable-agent-lifecycle.js';
import {
  flushDurableAgentMemory,
  persistDurableAuthoredMessage,
} from './durable-agent-memory.js';
import { finishDurableAgentHooks } from './durable-agent-tools.js';
import type { DurableNativeStart } from './durable-invocation-identity.js';
import { captureDurableInvocationIdentity } from './durable-invocation-identity.js';

export interface DurableAgentDescriptor {
  readonly version: 1;
  readonly slug: string;
  readonly definition: string;
  readonly input: string;
  readonly options: Record<string, unknown>;
  readonly correlation?: AuthorizedTurnCorrelation;
  readonly nativeOutput?: DurableNativeOutputFacts;
  readonly workspaceRoot?: string;
  readonly kernelInvocationId?: string;
  readonly startEvent?: DurableNativeStart;
  readonly mcpPromptOrigin?: VerifiedMcpPromptOrigin;
}
function descriptor(input: string): DurableAgentDescriptor {
  return z
    .object({
      version: z.literal(1),
      slug: z.string().min(1),
      definition: z.string().min(1),
      input: z.string(),
      options: z.record(z.string(), z.unknown()),
      nativeOutput: z
        .custom<DurableNativeOutputFacts>(isDurableNativeOutputFacts)
        .optional(),
      workspaceRoot: z.string().min(1).optional(),
      kernelInvocationId: z.string().min(1).optional(),
      startEvent: z
        .object({
          eventId: z.string().min(1),
          provider: z.literal('station-agent'),
          threadId: z.string().min(1),
          turnId: z.string().min(1),
          invocationId: z.string().min(1),
          createdAt: z.iso.datetime(),
          method: z.literal('turn.started'),
          prompt: z.string().optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        })
        .strict()
        .optional(),
      mcpPromptOrigin: z
        .object({
          serverId: z.string().min(1),
          name: z.string().min(1),
          untrusted: z.boolean(),
        })
        .strict()
        .optional(),
      correlation: z
        .object({
          accountId: z.string().min(1),
          sessionId: z.string().min(1),
          turnId: z.string().min(1),
          correlationId: z.string().min(1),
        })
        .strict()
        .optional(),
    })
    .strict()
    .parse(readAgentWire(input));
}

type RuntimeOwner = ReturnType<typeof createAgentRuntime>;
type Resume = (lease: AgentTurnLease) => Promise<void>;

/** Claims the journal fence before scheduling any recovered foreground work. */
function createDurableRecoveryHandoff(options: {
  readonly runtime: RuntimeOwner;
  readonly ready: () => boolean;
  readonly resume: Resume;
  readonly failed: (error: unknown) => void;
  readonly settled?: (lease: AgentTurnLease) => void | Promise<void>;
}): DurableTurnHandoff {
  const running = new Map<string, Promise<void>>();
  return async ({ record, turnId, signal }) => {
    if (signal.aborted) return 'retry';
    const key = {
      scopeId: 'station',
      conversationId: record.threadId,
      invocationId: turnId,
    };
    const id = JSON.stringify(key);
    if (running.has(id)) return 'claimed';
    const lease = await options.runtime.recover(key, options.ready);
    if (lease === 'not-owned' || lease === 'retry') return lease;
    if (signal.aborted) return 'retry';
    if (running.has(id)) return 'claimed';
    const work = lease
      .run(() => options.resume(lease))
      .finally(() => options.settled?.(lease));
    running.set(id, work);
    void work.catch(options.failed).finally(() => running.delete(id));
    return 'claimed';
  };
}

const owners = new Map<string, ReturnType<typeof createStationOwner>>();
const releasedOwners = new Set<string>();
function createStationOwner(home: string) {
  const path = join(home, 'data', 'agent-runtime', 'steps.sqlite');
  const identity = exactProcessIdentity(process.pid);
  const owner: OwnerIdentity = identity
    ? {
        id: randomUUID(),
        pid: process.pid,
        identityKind: 'exact',
        birth: identity.start,
      }
    : { id: randomUUID(), pid: process.pid, identityKind: 'unverified' };
  let released = false;
  const liveness = ownerLivenessFromProbe(probeExactProcessIdentity, {
    isReleased: (id) => releasedOwners.has(id),
  });
  let preview: FeaturePreviewSelector | undefined;
  let conversationIdentity: ((sessionId: string) => string) | undefined;
  let recoveryReady: ((input: DurableAgentDescriptor) => boolean) | undefined;
  let reconcile:
    | ((input: DurableAgentDescriptor, turnId: string) => void | Promise<void>)
    | undefined;
  let authorize: ((input: DurableAgentDescriptor) => Promise<void>) | undefined;
  let onWire:
    | ((
        input: DurableAgentDescriptor,
        turnId: string,
        wire: string,
      ) => void | Promise<void>)
    | undefined;
  let onApproval:
    | ((input: DurableAgentDescriptor, id: string) => void | Promise<void>)
    | undefined;
  let reportFailure: (error: unknown) => void = () => {};
  const agents = new Map<
    string,
    {
      definition: string;
      invoke: (
        input: string,
        options: Record<string, unknown>,
      ) => Promise<IStreamResult>;
      memory?: object;
    }
  >();
  const jobs = new Map<
    string,
    {
      key: RunKey;
      lease: () => AgentTurnLease | undefined;
      cancel: () => Promise<void>;
      pause: () => void;
      completion: Promise<void>;
    }
  >();
  const enabled = () =>
    preview?.select({ enabled: () => true, disabled: () => false }) ?? false;
  // Each command owns its handle. No connection survives a runtime shutdown or
  // home replacement; the journal's SQLite transaction remains the authority.
  const journal: AgentJournal = {
    async execute(command, context) {
      const database = openPrivateSqlite(path, 'Durable Station agent');
      try {
        return await openSqliteAgentJournal({ database }).execute(
          command,
          context,
        );
      } finally {
        database.close();
      }
    },
    async close() {},
  };
  const runtime = createAgentRuntime({
    journal,
    owner,
    liveness,
    implementation: 'station-agent/1',
    approvalSettled: async (spec, approval) => {
      if (onApproval) await onApproval(descriptor(spec.input), approval.id);
    },
    authorize: async (spec) => {
      const input = descriptor(spec.input);
      if (!enabled() || agents.get(input.slug)?.definition !== input.definition)
        throw new Error(
          'The durable agent configuration is no longer available',
        );
      await authorize?.(input);
    },
  });
  let resume: Resume | undefined;
  let failed: (error: unknown) => void = () => {};
  let settled: ((lease: AgentTurnLease) => void | Promise<void>) | undefined;
  const handoff = createDurableRecoveryHandoff({
    runtime,
    ready: () => resume !== undefined,
    resume: (lease) => {
      if (!resume)
        throw new Error('Durable Station agent recovery is unavailable');
      return resume(lease);
    },
    failed: (error) => failed(error),
    settled: (lease) => settled?.(lease),
  });
  return {
    runtime,
    journal,
    enabled,
    descriptor,
    async replay(
      lease: AgentTurnLease,
      consume: (result: IStreamResult) => Promise<void>,
    ) {
      const input = descriptor(lease.input);
      const agent = agents.get(input.slug);
      if (!agent || agent.definition !== input.definition || !agent.memory)
        throw new Error('The original durable agent is unavailable.');
      if (typeof input.options.userId !== 'string')
        throw new Error('The durable conversation user is unavailable.');
      await persistDurableAuthoredMessage(
        lease,
        agent.memory,
        input.input,
        input.options.userId,
      );
      const result = await agent.invoke(input.input, {
        ...input.options,
        signal: lease.signal,
        abortSignal: lease.signal,
      });
      await consume(result);
      await lease.entry('native-terminal-summary', {
        text: await result.text,
        usage: await result.usage,
        finishReason: await result.finishReason,
      });
      await flushDurableAgentMemory(lease);
      await finishDurableAgentHooks(lease);
    },
    approvals(conversationId: string, turnId: string): DurableApproval[] {
      if (!existsSync(path)) return [];
      const database = openPrivateSqlite(path, 'Durable Station agent');
      try {
        return readSqliteAgentApprovals({
          database,
          key: { scopeId: 'station', conversationId, invocationId: turnId },
        });
      } finally {
        database.close();
      }
    },
    read(conversationId: string, turnId: string) {
      if (!existsSync(path)) return undefined;
      const database = openPrivateSqlite(path, 'Durable Station agent');
      try {
        return readSqliteAgentTurn({
          database,
          key: { scopeId: 'station', conversationId, invocationId: turnId },
        });
      } finally {
        database.close();
      }
    },
    readFrame(conversationId: string, turnId: string, id: string) {
      if (!existsSync(path)) return undefined;
      const database = openPrivateSqlite(path, 'Durable Station agent');
      try {
        return readSqliteAgentFrame({
          database,
          key: { scopeId: 'station', conversationId, invocationId: turnId },
          id,
        });
      } finally {
        database.close();
      }
    },
    frames(conversationId: string, turnId: string) {
      if (!existsSync(path)) return [];
      const database = openPrivateSqlite(path, 'Durable Station agent');
      try {
        return readSqliteAgentFrames({
          database,
          key: { scopeId: 'station', conversationId, invocationId: turnId },
        });
      } finally {
        database.close();
      }
    },
    configure(options: {
      preview: FeaturePreviewSelector;
      conversationIdentity?: typeof conversationIdentity;
      authorize?: (input: DurableAgentDescriptor) => Promise<void>;
      onWire?: typeof onWire;
      failed: (error: unknown) => void;
      onApproval?: typeof onApproval;
      recoveryReady?: typeof recoveryReady;
      reconcile?: typeof reconcile;
    }) {
      preview = options.preview;
      conversationIdentity = options.conversationIdentity;
      recoveryReady = options.recoveryReady;
      reconcile = options.reconcile;
      authorize = options.authorize;
      onWire = options.onWire;
      onApproval = options.onApproval;
      reportFailure = options.failed;
    },
    registerAgent(
      slug: string,
      definition: string,
      invoke: (
        input: string,
        options: Record<string, unknown>,
      ) => Promise<IStreamResult>,
      memory?: object,
    ) {
      agents.set(slug, { definition, invoke, memory });
    },
    async foreground(input: {
      agent: object;
      slug: string;
      definition: string;
      input: string;
      options: Record<string, unknown>;
      invoke: (lease?: AgentTurnLease) => Promise<IStreamResult>;
    }): Promise<IStreamResult> {
      if (!enabled()) return input.invoke();
      if (
        typeof input.input !== 'string' ||
        typeof input.options.conversationId !== 'string' ||
        typeof input.options.userId !== 'string'
      )
        throw new Error(
          'This preview requires a text turn bound to a conversation and user.',
        );
      const options: Record<string, unknown> = {};
      const userId = input.options.userId;
      for (const key of [
        'conversationId',
        'userId',
        'clientTurnId',
        'traceId',
        'title',
        'delegation',
      ])
        if (input.options[key] !== undefined) options[key] = input.options[key];
      const correlation = currentAuthorizedTurnCorrelation();
      const mcpPromptOrigin = currentMcpPromptOrigin();
      if (correlation && correlation.sessionId !== input.options.conversationId)
        throw new Error('The native conversation identity changed.');
      const identity = correlation
        ? captureDurableInvocationIdentity(correlation)
        : undefined;
      const kernelInvocationId = identity?.invocationId;
      const nativeOutput = captureDurableNativeOutputFacts();
      const workspaceRoot = currentNativeExecutionWorkspace()?.workspaceRoot;
      const captured: DurableAgentDescriptor = {
        version: 1,
        slug: input.slug,
        definition: input.definition,
        input: input.input,
        options,
        ...(correlation ? { correlation } : {}),
        ...(kernelInvocationId ? { kernelInvocationId } : {}),
        ...(identity ? { startEvent: identity.startEvent } : {}),
        ...(mcpPromptOrigin ? { mcpPromptOrigin } : {}),
        ...(nativeOutput ? { nativeOutput } : {}),
        ...(workspaceRoot ? { workspaceRoot } : {}),
      };
      const key = {
        scopeId: 'station',
        conversationId: input.options.conversationId,
        invocationId:
          correlation?.turnId ??
          (typeof options.clientTurnId === 'string'
            ? options.clientTurnId
            : typeof options.traceId === 'string'
              ? options.traceId
              : randomUUID()),
      };
      let lease: AgentTurnLease | undefined;
      let pendingCancel = false;
      let pendingPause = false;
      let transportAttached = false;
      let finished = false;
      let allowSettlement!: () => void;
      const settlementBarrier = new Promise<void>((resolve) => {
        allowSettlement = resolve;
      });
      const channel = new DurableForegroundChannel<IStreamChunk>();
      let resolve!: (result: IStreamResult) => void;
      let reject!: (error: unknown) => void;
      const ready = new Promise<IStreamResult>((accept, deny) => {
        resolve = accept;
        reject = deny;
      });
      let complete!: () => void;
      let fail!: (error: unknown) => void;
      const completion = new Promise<void>((accept, deny) => {
        complete = accept;
        fail = deny;
      });
      let resolveLease!: (value: AgentTurnLease) => void;
      let rejectLease!: (error: unknown) => void;
      const leaseReady = new Promise<AgentTurnLease>((accept, deny) => {
        resolveLease = accept;
        rejectLease = deny;
      });
      void leaseReady.catch(() => {});
      const id = JSON.stringify(key);
      let delivery: Promise<void> = Promise.resolve();
      const deliver = (wire: string) => {
        delivery = delivery.then(async () => {
          await onWire?.(captured, key.invocationId, wire);
        });
        return delivery;
      };
      registerDurableForeground(input.agent, key.conversationId, {
        invocationId: key.invocationId,
        completion,
        finished: () => finished,
        cancelled: () => pendingCancel || lease?.signal.aborted === true,
        attachTransport: () => {
          transportAttached = true;
        },
        allowSettlement,
        frame: async (frameId, wire) => (await leaseReady).frame(frameId, wire),
        onDetach: async () => {
          await leaseReady;
          const database = openPrivateSqlite(path, 'Durable Station agent');
          let frames: AgentFrame[];
          try {
            frames = readSqliteAgentFrames({ database, key });
          } finally {
            database.close();
          }
          for (const frame of frames)
            await deliver(encodeDurableAgentFrame(key.invocationId, frame));
        },
        onWire: deliver,
        failed: reportFailure,
      });
      jobs.set(id, {
        key,
        lease: () => lease,
        completion,
        cancel: async () => {
          pendingCancel = true;
          const current = await leaseReady;
          await current.cancel();
        },
        pause: () => {
          pendingPause = true;
          lease?.pause();
        },
      });
      const final: IStreamChunk[] = [];
      const work = (async () => {
        lease = await runtime.start({
          key,
          input: agentWire(captured),
          ...(conversationIdentity
            ? {
                affinityConversationId: conversationIdentity(
                  key.conversationId,
                ),
              }
            : {}),
          implementation: 'station-agent/1',
        });
        resolveLease(lease);
        if (pendingPause) lease.pause();
        else if (pendingCancel) await lease.cancel();
        const current = lease;
        await current.run(async () => {
          const memory = agents.get(input.slug)?.memory;
          if (!memory)
            throw new Error(
              'The durable conversation store is not registered.',
            );
          await persistDurableAuthoredMessage(
            current,
            memory,
            input.input,
            userId,
          );
          const result = await input.invoke(current);
          resolve(
            new Proxy(result, {
              get(target, property) {
                return property === 'fullStream'
                  ? channel
                  : Reflect.get(target, property, target);
              },
            }),
          );
          let ending = false;
          for await (const chunk of result.fullStream) {
            if (chunk.type === 'error')
              throw new Error(
                'The durable agent could not finish its response.',
              );
            if (chunk.type === 'finish') ending = true;
            if (ending) {
              if (final.length >= 128)
                throw new Error('Unexpected data after the final response.');
              final.push(chunk);
            } else await channel.push(chunk);
          }
          const text = await result.text;
          const usage = await result.usage;
          const finishReason = await result.finishReason;
          await current.entry('native-terminal-summary', {
            text,
            usage,
            finishReason,
          });
          await flushDurableAgentMemory(current);
          await finishDurableAgentHooks(current);
          if (transportAttached) {
            for (const chunk of final) await channel.push(chunk);
            channel.finish();
            await settlementBarrier;
            if (channel.abandoned && !current.signal.aborted) {
              current.pause();
              throw new Error(
                'The turn output has an unknown delivery outcome.',
              );
            }
          }
        });
      })();
      void work.then(
        async () => {
          if (!transportAttached)
            for (const chunk of final) await channel.push(chunk);
          finished = true;
          channel.finish();
          jobs.delete(id);
          complete();
        },
        (error) => {
          finished = true;
          rejectLease(error);
          reject(error);
          channel.finish(error);
          jobs.delete(id);
          fail(error);
          reportFailure(error);
        },
      );
      return ready;
    },
    async cancel(conversationId: string, turnId?: string) {
      const controls: Promise<void>[] = [];
      for (const job of jobs.values())
        if (
          job.key.conversationId === conversationId &&
          (!turnId || job.key.invocationId === turnId)
        )
          controls.push(job.cancel());
      if (controls.length) await Promise.all(controls);
      else {
        for (const record of this.list())
          if (
            record.spec.key.conversationId === conversationId &&
            (!turnId || record.spec.key.invocationId === turnId)
          ) {
            const answer = await journal.execute(
              {
                type: 'requestCancel',
                key: record.spec.key,
                inputDigest: record.inputDigest,
              },
              { liveness },
            );
            if (answer.kind !== 'owned')
              throw new Error('The Stop request has an unknown outcome.');
          }
        await runtime.cancel(conversationId, turnId);
      }
    },
    owns(conversationId: string, turnId: string) {
      return [...jobs.values()].some(
        (job) =>
          job.key.conversationId === conversationId &&
          job.key.invocationId === turnId,
      );
    },
    isCurrent(lease: AgentTurnLease) {
      if (released || lease.signal.aborted || !existsSync(path)) return false;
      const database = openPrivateSqlite(path, 'Durable Station agent');
      try {
        const current = readSqliteAgentTurn({ database, key: lease.key });
        return (
          !!current &&
          current.turn.fence.owner.id === owner.id &&
          current.providerSessionId === lease.providerSessionId &&
          (current.turn.state === 'running' ||
            current.turn.state === 'completed')
        );
      } finally {
        database.close();
      }
    },
    async pause() {
      for (const job of jobs.values()) job.pause();
      runtime.pause();
      await Promise.all(
        [...jobs.values()].map((job) => job.completion.catch(() => {})),
      );
      released = true;
      releasedOwners.add(owner.id);
      owners.delete(home);
    },
    list() {
      if (!existsSync(path)) return [];
      const database = openPrivateSqlite(path, 'Durable Station agent');
      try {
        openSqliteAgentJournal({ database });
        return listSqliteAgentTurns({ database });
      } finally {
        database.close();
      }
    },
    registerRecovery(
      execute: Resume,
      reportFailure: (error: unknown) => void,
      onSettled?: (lease: AgentTurnLease) => void | Promise<void>,
    ) {
      resume = execute;
      failed = reportFailure;
      settled = onSettled;
    },
    recover: (async (input) => {
      if (input.signal.aborted) return 'retry';
      if (!existsSync(path)) return 'not-owned';
      const database = openPrivateSqlite(path, 'Durable Station agent');
      let saved: ReturnType<typeof readSqliteAgentTurn>;
      try {
        openSqliteAgentJournal({ database });
        saved = readSqliteAgentTurn({
          database,
          key: {
            scopeId: 'station',
            conversationId: input.record.threadId,
            invocationId: input.turnId,
          },
        });
      } finally {
        database.close();
      }
      if (!saved) return 'not-owned';
      const captured = descriptor(saved.turn.spec.input);
      if (
        (!saved.turn.cancelRequested &&
          (!enabled() ||
            agents.get(captured.slug)?.definition !== captured.definition)) ||
        recoveryReady?.(captured) === false
      )
        return 'retry';
      if (saved.turn.state !== 'running') {
        if (!reconcile) return 'retry';
        await reconcile(captured, input.turnId);
        return 'claimed';
      }
      return handoff(input);
    }) as DurableTurnHandoff,
  };
}
export function stationAgentRuntimeOwner(home: string) {
  let owner = owners.get(home);
  if (!owner) {
    owner = createStationOwner(home);
    owners.set(home, owner);
  }
  return owner;
}
