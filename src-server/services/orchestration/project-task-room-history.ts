import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import {
  channelProposalDigestInput,
  validateChannelSequencingEnvelope,
} from '@kontourai/station-contracts/channel-log';
import type {
  ProjectTaskRoomAppendBody,
  ProjectTaskRoomAppendIntent,
  ProjectTaskRoomAppendOutcome,
  ProjectTaskRoomAuthority,
  ProjectTaskRoomBody,
  ProjectTaskRoomCloseOutcome,
  ProjectTaskRoomGrant,
  ProjectTaskRoomGrantKind,
  ProjectTaskRoomOpenOutcome,
  ProjectTaskRoomPrincipal,
  ProjectTaskRoomReadOutcome,
  ProjectTaskRoomRecord,
  ProjectTaskRoomResolvedLink,
  ProjectTaskRoomScope,
} from '@kontourai/station-contracts/project-task-room';
import {
  PROJECT_TASK_ROOM_MAX_PAGE_JSON_ITEMS,
  PROJECT_TASK_ROOM_MAX_PAGE_RECORDS,
} from '@kontourai/station-contracts/project-task-room';
import {
  projectTaskRoomHistoryDuration,
  projectTaskRoomHistoryOperations,
  projectTaskRoomHistoryPageRecords,
} from '../../telemetry/metrics.js';
import { measureBoundedJson, plainDataObject } from './bounded-json.js';

export const PROJECT_TASK_ROOM_LIMITS = Object.freeze({
  requestBytes: 48 * 1024,
  bodyBytes: 16 * 1024,
  pageRecords: PROJECT_TASK_ROOM_MAX_PAGE_RECORDS,
  pageBytes: 512 * 1024,
  jsonDepth: 8,
  jsonItems: 160,
  stringBytes: 8 * 1024,
  idBytes: 256,
  retentionRecords: 10_000,
  retentionBytes: 64 * 1024 * 1024,
  maxIdentities: 50_000,
  workerResponseMs: 5_000,
});

export interface ProjectTaskRoomCapabilityReceipt {
  receiptId: string;
  capability: ProjectTaskRoomGrantKind;
  scope: ProjectTaskRoomScope;
  principal: ProjectTaskRoomPrincipal;
  policyRevision: string;
}
export type ProjectTaskRoomCapabilityResolution =
  | { kind: 'granted'; receipt: ProjectTaskRoomCapabilityReceipt }
  | { kind: 'not-found' | 'denied' | 'revoked' | 'unavailable' };
export interface ProjectTaskRoomCapabilityAuthority {
  resolve(input: {
    grant: ProjectTaskRoomGrant<ProjectTaskRoomGrantKind>;
    required: ProjectTaskRoomGrantKind;
  }): Promise<ProjectTaskRoomCapabilityResolution>;
}
export type ProjectTaskRoomLinkResolution =
  | { kind: 'resolved'; link: ProjectTaskRoomResolvedLink }
  | { kind: 'unresolved' | 'unverified' | 'unavailable' };
export interface ProjectTaskRoomLinkAuthority {
  resolve(input: {
    kind: ProjectTaskRoomResolvedLink['kind'];
    reference: string;
    scope: ProjectTaskRoomScope;
  }): Promise<ProjectTaskRoomLinkResolution>;
}
export type ProjectTaskRoomAgentResolution =
  | {
      kind: 'authorized';
      principal: Extract<ProjectTaskRoomPrincipal, { kind: 'agent' }>;
    }
  | { kind: 'denied' | 'revoked' | 'unavailable' };
export interface ProjectTaskRoomAgentGrantAuthority {
  revalidate(
    receipt: ProjectTaskRoomCapabilityReceipt,
  ): Promise<ProjectTaskRoomAgentResolution>;
}

interface StorageAdapter {
  request(
    value: unknown,
    beforeCommit?: () => Promise<boolean>,
  ): Promise<unknown>;
  close(): Promise<ProjectTaskRoomCloseOutcome>;
}
export interface ProjectTaskRoomHistory extends ProjectTaskRoomAuthority {
  findByProposal(input: {
    grant: ProjectTaskRoomGrant<'history-read'>;
    proposalId: string;
  }): Promise<ProjectTaskRoomRecord | undefined>;
  /** EventStore's synchronous shutdown fence; public callers use close(). */
  dispose(): void;
}

interface ProjectTaskRoomHistoryInput {
  databasePath: string;
  capabilities: ProjectTaskRoomCapabilityAuthority;
  links?: ProjectTaskRoomLinkAuthority;
  agents?: ProjectTaskRoomAgentGrantAuthority;
  /** Test-only response-loss seam after a durable append. */
  unavailableAfterCommitOnce?: boolean;
}
interface ProjectTaskRoomHistoryTestInput extends ProjectTaskRoomHistoryInput {
  /** Test-only adapter; production always owns a worker-thread connection. */
  storage?: StorageAdapter;
  faultAfterCommitOnce?: boolean;
  /** Test-only worker entry for startup/crash protocol proofs. */
  workerSourceUrl?: URL;
  limits?: {
    retentionRecords: number;
    retentionBytes: number;
    maxIdentities: number;
  };
}

export function createProjectTaskRoomHistory(
  input: ProjectTaskRoomHistoryInput,
): ProjectTaskRoomHistory {
  return createProjectTaskRoomHistoryInternal(input);
}

/** Deliberate non-production factory for bounded retention/fault proofs. */
export function createProjectTaskRoomHistoryForTest(
  input: ProjectTaskRoomHistoryTestInput,
): ProjectTaskRoomHistory {
  return createProjectTaskRoomHistoryInternal(input);
}

function createProjectTaskRoomHistoryInternal(
  input: ProjectTaskRoomHistoryTestInput,
): ProjectTaskRoomHistory {
  const storageLimits = input.limits ?? {
    retentionRecords: PROJECT_TASK_ROOM_LIMITS.retentionRecords,
    retentionBytes: PROJECT_TASK_ROOM_LIMITS.retentionBytes,
    maxIdentities: PROJECT_TASK_ROOM_LIMITS.maxIdentities,
  };
  const storage =
    input.storage ??
    createWorkerStorage(
      input.databasePath,
      input.faultAfterCommitOnce,
      input.unavailableAfterCommitOnce,
      input.workerSourceUrl,
      storageLimits,
    );
  let closed = false;
  let generation = 0;
  let closeSettlement: Promise<ProjectTaskRoomCloseOutcome> | undefined;
  const active = (operationGeneration: number) =>
    !closed && generation === operationGeneration;

  async function resolveCapability(
    grant: ProjectTaskRoomGrant<ProjectTaskRoomGrantKind>,
    required: ProjectTaskRoomGrantKind,
  ): Promise<ProjectTaskRoomCapabilityResolution> {
    if (!isGrant(grant)) return { kind: 'denied' };
    try {
      const result = await input.capabilities.resolve({ grant, required });
      return validCapabilityResult(result, required)
        ? deepCloneFreeze(result)
        : { kind: 'unavailable' };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  async function resolveAuthorized(
    grant: ProjectTaskRoomGrant<ProjectTaskRoomGrantKind>,
    required: ProjectTaskRoomGrantKind,
    expected?: ProjectTaskRoomCapabilityReceipt,
  ): Promise<ProjectTaskRoomCapabilityResolution> {
    const resolved = await resolveCapability(grant, required);
    if (resolved.kind !== 'granted') return resolved;
    if (expected && canonical(resolved.receipt) !== canonical(expected))
      return { kind: 'unavailable' };
    if (resolved.receipt.principal.kind !== 'agent') return resolved;
    if (!input.agents) return { kind: 'denied' };
    try {
      const agent = await input.agents.revalidate(resolved.receipt);
      if (!validAgentResolution(agent)) return { kind: 'unavailable' };
      if (agent.kind !== 'authorized') return agent;
      return canonical(agent.principal) ===
        canonical(resolved.receipt.principal)
        ? resolved
        : { kind: 'unavailable' };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  async function open({
    grant,
  }: {
    grant: ProjectTaskRoomGrant<'discover'>;
  }): Promise<ProjectTaskRoomOpenOutcome> {
    const started = performance.now();
    const operationGeneration = generation;
    let outcome: ProjectTaskRoomOpenOutcome = { kind: 'unavailable' };
    if (!closed) {
      const resolved = await resolveAuthorized(grant, 'discover');
      if (!active(operationGeneration)) {
        observe('open', 'unavailable', started);
        return { kind: 'unavailable' };
      }
      if (resolved.kind === 'not-found') outcome = { kind: 'not-found' };
      else if (resolved.kind === 'denied' || resolved.kind === 'revoked')
        outcome = { kind: 'denied' };
      else if (resolved.kind === 'granted') {
        const finalAuthorization = await resolveAuthorized(
          grant,
          'discover',
          resolved.receipt,
        );
        if (!active(operationGeneration)) {
          observe('open', 'unavailable', started);
          return { kind: 'unavailable' };
        }
        if (finalAuthorization.kind !== 'granted') {
          outcome =
            finalAuthorization.kind === 'unavailable'
              ? { kind: 'unavailable' }
              : { kind: 'denied' };
          observe('open', outcome.kind, started);
          return deepCloneFreeze(outcome);
        }
        const { scope, policyRevision } = finalAuthorization.receipt;
        const channelId = channelIdFor(scope);
        const stored = await totalStorage(
          storage,
          {
            type: 'open',
            scope,
            channelId,
            policyRevision,
            authorizationId: finalAuthorization.receipt.receiptId,
          },
          async () => {
            if (!active(operationGeneration)) return false;
            const commitAuthorization = await resolveAuthorized(
              grant,
              'discover',
              finalAuthorization.receipt,
            );
            return commitAuthorization.kind === 'granted';
          },
        );
        if (!active(operationGeneration)) {
          observe('open', 'unavailable', started);
          return { kind: 'unavailable' };
        }
        if (isKind(stored, 'opened'))
          outcome = { kind: 'opened', scope, channelId, assurance: 'L0' };
        else if (isKind(stored, 'existing'))
          outcome = { kind: 'existing', scope, channelId, assurance: 'L0' };
      }
    }
    observe('open', outcome.kind, started);
    return deepCloneFreeze(outcome);
  }

  async function append({
    grant,
    intent: providedIntent,
  }: {
    grant: ProjectTaskRoomGrant<
      'message-write' | 'lifecycle-append' | 'revision-link' | 'agent-publish'
    >;
    intent: ProjectTaskRoomAppendIntent;
  }): Promise<ProjectTaskRoomAppendOutcome> {
    const started = performance.now();
    const operationGeneration = generation;
    let outcome: ProjectTaskRoomAppendOutcome = { kind: 'unavailable' };
    let intent: ProjectTaskRoomAppendIntent | undefined;
    if (validIntent(providedIntent)) {
      try {
        intent = deepCloneFreeze(providedIntent);
      } catch {
        intent = undefined;
      }
    }
    if (!closed && intent && isGrant(grant)) {
      const required = grant.capability;
      const resolved = await resolveAuthorized(grant, required);
      if (!active(operationGeneration)) {
        observe('append', 'unavailable', started);
        return { kind: 'unavailable' };
      }
      if (
        resolved.kind === 'denied' ||
        resolved.kind === 'revoked' ||
        resolved.kind === 'not-found'
      )
        outcome = { kind: 'denied' };
      else if (resolved.kind === 'granted') {
        const principalAuthorized =
          resolved.receipt.principal.kind === 'agent'
            ? required === 'agent-publish'
            : required === capabilityFor(intent.body);
        if (!principalAuthorized) outcome = { kind: 'denied' };
        if (principalAuthorized) {
          const body = await resolveBody(
            intent.body,
            resolved.receipt.scope,
            input.links,
          );
          if (!active(operationGeneration)) {
            observe('append', 'unavailable', started);
            return { kind: 'unavailable' };
          }
          if (body.kind !== 'resolved') {
            outcome =
              body.kind === 'unavailable'
                ? { kind: 'unavailable' }
                : { kind: 'rejected', reason: body.kind };
          } else {
            const finalAuthorization = await resolveAuthorized(
              grant,
              required,
              resolved.receipt,
            );
            if (!active(operationGeneration)) {
              observe('append', 'unavailable', started);
              return { kind: 'unavailable' };
            }
            if (finalAuthorization.kind !== 'granted') {
              outcome =
                finalAuthorization.kind === 'unavailable'
                  ? { kind: 'unavailable' }
                  : { kind: 'denied' };
              observe('append', outcome.kind, started);
              return deepCloneFreeze(outcome);
            }
            const principal = finalAuthorization.receipt.principal;
            const semantic = {
              schemaVersion: 'station.project-task-room-proposal-semantics/v1',
              scope: finalAuthorization.receipt.scope,
              channelId: channelIdFor(finalAuthorization.receipt.scope),
              epoch: 0,
              proposalId: intent.proposalId,
              occurredAt: intent.occurredAt,
              principal,
              ...(intent.correlationId
                ? { correlationId: intent.correlationId }
                : {}),
              ...(intent.causationId
                ? { causationId: intent.causationId }
                : {}),
              body: body.body,
              grantReceipt: finalAuthorization.receipt,
            };
            const proposalDigest = sha(canonical(semantic));
            const stored = await totalStorage(
              storage,
              {
                type: 'append',
                scope: finalAuthorization.receipt.scope,
                channelId: semantic.channelId,
                policyRevision: finalAuthorization.receipt.policyRevision,
                proposalId: intent.proposalId,
                proposalDigest,
                occurredAt: intent.occurredAt,
                ...(intent.correlationId
                  ? { correlationId: intent.correlationId }
                  : {}),
                ...(intent.causationId
                  ? { causationId: intent.causationId }
                  : {}),
                principal,
                body: body.body,
                grantReceipt: finalAuthorization.receipt,
                authorizationId: finalAuthorization.receipt.receiptId,
              },
              async () => {
                if (!active(operationGeneration)) return false;
                const commitAuthorization = await resolveAuthorized(
                  grant,
                  required,
                  finalAuthorization.receipt,
                );
                return commitAuthorization.kind === 'granted';
              },
            );
            if (!active(operationGeneration)) {
              observe('append', 'unavailable', started);
              return { kind: 'unavailable' };
            }
            if (
              isAppendStorage(stored, {
                proposalId: intent.proposalId,
                proposalDigest,
                channelId: semantic.channelId,
              })
            )
              outcome =
                stored.kind === 'conflict'
                  ? { kind: 'rejected', reason: 'idempotency-conflict' }
                  : stored.kind === 'capacity'
                    ? { kind: 'rejected', reason: 'capacity' }
                    : stored.kind === 'denied'
                      ? { kind: 'denied' }
                      : stored.kind === 'unavailable'
                        ? { kind: 'unavailable' }
                        : stored;
          }
        }
      }
    } else if (!closed)
      outcome = intent
        ? { kind: 'denied' }
        : { kind: 'rejected', reason: 'malformed' };
    observe(
      'append',
      outcome.kind === 'rejected' ? outcome.reason : outcome.kind,
      started,
    );
    return deepCloneFreeze(outcome);
  }

  async function read({
    grant,
    cursor: providedCursor,
    limit,
  }: {
    grant: ProjectTaskRoomGrant<'history-read'>;
    cursor?: import('@kontourai/station-contracts/project-task-room').ProjectTaskRoomCursor;
    limit?: number;
  }): Promise<ProjectTaskRoomReadOutcome> {
    const started = performance.now();
    const operationGeneration = generation;
    let outcome: ProjectTaskRoomReadOutcome = { kind: 'unavailable' };
    let cursor:
      | import('@kontourai/station-contracts/project-task-room').ProjectTaskRoomCursor
      | undefined;
    const readInputValid = validReadInput(providedCursor, limit);
    if (readInputValid && providedCursor) {
      try {
        cursor = deepCloneFreeze(providedCursor);
      } catch {
        cursor = undefined;
      }
    }
    if (!closed && readInputValid && (!providedCursor || cursor)) {
      const resolved = await resolveAuthorized(grant, 'history-read');
      if (!active(operationGeneration)) {
        observe('read', 'unavailable', started);
        return { kind: 'unavailable' };
      }
      if (
        resolved.kind === 'denied' ||
        resolved.kind === 'revoked' ||
        resolved.kind === 'not-found'
      )
        outcome = { kind: 'denied' };
      else if (resolved.kind === 'granted') {
        const stored = await totalStorage(storage, {
          type: 'read',
          scope: resolved.receipt.scope,
          channelId: channelIdFor(resolved.receipt.scope),
          ...(cursor ? { cursor } : {}),
          limit: Math.min(limit ?? 50, PROJECT_TASK_ROOM_LIMITS.pageRecords),
          pageBytes: PROJECT_TASK_ROOM_LIMITS.pageBytes - 4_096,
        });
        if (!active(operationGeneration)) {
          observe('read', 'unavailable', started);
          return { kind: 'unavailable' };
        }
        const deliveryAuthorization = await resolveAuthorized(
          grant,
          'history-read',
          resolved.receipt,
        );
        if (!active(operationGeneration)) {
          observe('read', 'unavailable', started);
          return { kind: 'unavailable' };
        }
        if (deliveryAuthorization.kind !== 'granted')
          outcome =
            deliveryAuthorization.kind === 'unavailable'
              ? { kind: 'unavailable' }
              : { kind: 'denied' };
        else if (
          isReadStorage(stored, {
            scope: resolved.receipt.scope,
            channelId: channelIdFor(resolved.receipt.scope),
            cursor,
            receipt: resolved.receipt,
          })
        )
          outcome = stored;
      }
    } else if (!closed) outcome = { kind: 'invalid-cursor' };
    observe(
      'read',
      outcome.kind,
      started,
      outcome.kind === 'available' ? outcome.records.length : undefined,
    );
    return deepCloneFreeze(outcome);
  }

  async function findByProposal({
    grant,
    proposalId,
  }: Parameters<ProjectTaskRoomHistory['findByProposal']>[0]): Promise<
    ProjectTaskRoomRecord | undefined
  > {
    const operationGeneration = generation;
    if (closed || !id(proposalId)) return undefined;
    const resolved = await resolveAuthorized(grant, 'history-read');
    if (!active(operationGeneration) || resolved.kind !== 'granted')
      return undefined;
    const located = await totalStorage(storage, {
      type: 'locate-proposal',
      scope: resolved.receipt.scope,
      channelId: channelIdFor(resolved.receipt.scope),
      proposalId,
    });
    if (
      !active(operationGeneration) ||
      !isPlainOwn(located, ['kind', 'cursor']) ||
      located.kind !== 'located' ||
      !validReadInput(located.cursor, 1)
    )
      return undefined;
    // Reuse one bounded page read: it verifies the history, cursor, record,
    // exact scope and delivery-time authority. No quadratic pagination scan.
    const page = await read({
      grant,
      cursor:
        located.cursor as import('@kontourai/station-contracts/project-task-room').ProjectTaskRoomCursor,
      limit: 1,
    });
    if (
      !active(operationGeneration) ||
      page.kind !== 'available' ||
      page.records.length !== 1
    )
      return undefined;
    const record = page.records[0];
    return record.envelope.proposal.proposalId === proposalId
      ? record
      : undefined;
  }

  function close(): Promise<ProjectTaskRoomCloseOutcome> {
    if (closeSettlement) return closeSettlement;
    closed = true;
    generation += 1;
    closeSettlement = (async () => {
      try {
        const result = await storage.close();
        return isCloseOutcome(result) ? result : { kind: 'unavailable' };
      } catch {
        return { kind: 'unavailable' };
      }
    })();
    return closeSettlement;
  }
  function dispose() {
    void close();
  }
  return Object.freeze({ open, append, read, findByProposal, close, dispose });
}

function createWorkerStorage(
  databasePath: string,
  faultAfterCommitOnce?: boolean,
  unavailableAfterCommitOnce?: boolean,
  workerSourceUrl?: URL,
  limits: {
    retentionRecords: number;
    retentionBytes: number;
    maxIdentities: number;
  } = {
    retentionRecords: PROJECT_TASK_ROOM_LIMITS.retentionRecords,
    retentionBytes: PROJECT_TASK_ROOM_LIMITS.retentionBytes,
    maxIdentities: PROJECT_TASK_ROOM_LIMITS.maxIdentities,
  },
): StorageAdapter {
  const sourceUrl =
    workerSourceUrl ??
    new URL(
      import.meta.url.endsWith('.ts')
        ? './project-task-room-history-worker.ts'
        : './project-task-room-history-worker.js',
      import.meta.url,
    );
  const worker = new Worker(sourceUrl, {
    workerData: {
      databasePath,
      ...limits,
      faultAfterCommitOnce,
      unavailableAfterCommitOnce,
    },
    ...(sourceUrl.pathname.endsWith('.ts')
      ? { execArgv: ['--import', 'tsx'] }
      : {}),
  });
  let sequence = 0;
  let closed = false;
  let terminal = false;
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
      beforeCommit?: () => Promise<boolean>;
    }
  >();
  const failAll = () => {
    terminal = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ kind: 'unavailable' });
    }
    pending.clear();
  };
  worker.on('message', (message: unknown) => {
    if (isPlainOwn(message, ['type', 'id', 'authorizationId'])) {
      if (message.type !== 'authorize' || !Number.isSafeInteger(message.id))
        return;
      const entry = pending.get(message.id as number);
      const respond = (granted: boolean) => {
        try {
          worker.postMessage({
            type: 'authorization',
            id: message.id,
            authorizationId: message.authorizationId,
            granted,
          });
        } catch {
          failAll();
        }
      };
      if (!entry?.beforeCommit) respond(false);
      else void entry.beforeCommit().then(respond, () => respond(false));
      return;
    }
    if (!isPlainOwn(message, ['id', 'result'])) {
      failAll();
      void worker.terminate();
      return;
    }
    const id = (message as { id: unknown }).id;
    if (!Number.isSafeInteger(id)) return;
    const entry = pending.get(id as number);
    if (!entry) return;
    pending.delete(id as number);
    clearTimeout(entry.timer);
    entry.resolve((message as { result: unknown }).result);
  });
  worker.on('error', failAll);
  worker.on('exit', failAll);
  const request = (value: unknown, beforeCommit?: () => Promise<boolean>) =>
    new Promise<unknown>((resolve) => {
      if (closed || terminal) {
        resolve({ kind: 'unavailable' });
        return;
      }
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ kind: 'unavailable' });
        terminal = true;
        void worker.terminate();
      }, PROJECT_TASK_ROOM_LIMITS.workerResponseMs);
      pending.set(id, { resolve, timer, beforeCommit });
      try {
        worker.postMessage({ id, request: value });
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ kind: 'unavailable' });
      }
    });
  return {
    request,
    async close() {
      if (closed) return { kind: terminal ? 'unavailable' : 'closed' };
      const result = await request({ type: 'close' });
      closed = true;
      await worker.terminate();
      failAll();
      return isKind(result, 'closed')
        ? { kind: 'closed' }
        : { kind: 'unavailable' };
    },
  };
}

async function totalStorage(
  storage: StorageAdapter,
  value: unknown,
  beforeCommit?: () => Promise<boolean>,
) {
  try {
    return await storage.request(value, beforeCommit);
  } catch {
    return { kind: 'unavailable' };
  }
}
function capabilityFor(
  body: ProjectTaskRoomAppendBody,
): ProjectTaskRoomGrantKind {
  return body.kind === 'human-message'
    ? 'message-write'
    : body.kind === 'outcome-link'
      ? 'revision-link'
      : 'lifecycle-append';
}
async function resolveBody(
  body: ProjectTaskRoomAppendBody,
  scope: ProjectTaskRoomScope,
  links?: ProjectTaskRoomLinkAuthority,
): Promise<
  | { kind: 'resolved'; body: ProjectTaskRoomBody }
  | { kind: 'link-unresolved' | 'link-unverified' | 'unavailable' }
> {
  if (body.kind === 'human-message')
    return {
      kind: 'resolved',
      body: { kind: 'human-message', text: body.text },
    };
  if (body.kind === 'outcome-link') {
    const link = await totalLink(links, body.linkKind, body.reference, scope);
    return link.kind === 'resolved'
      ? { kind: 'resolved', body: { kind: 'outcome-link', link: link.link } }
      : { kind: linkFailure(link.kind) };
  }
  let run: ProjectTaskRoomResolvedLink | undefined;
  if (body.runReference) {
    const value = await totalLink(links, 'run', body.runReference, scope);
    if (value.kind !== 'resolved') return { kind: linkFailure(value.kind) };
    run = value.link;
  }
  if (body.kind === 'live-work-presence-ended')
    return {
      kind: 'resolved',
      body: {
        kind: body.kind,
        sessionId: body.sessionId,
        reason: body.reason,
        ...(run ? { run } : {}),
      },
    };
  let revision: ProjectTaskRoomResolvedLink | undefined;
  let outcomeLink: ProjectTaskRoomResolvedLink | undefined;
  if (body.kind === 'live-work-finished' && body.revisionReference) {
    const value = await totalLink(
      links,
      'revision',
      body.revisionReference,
      scope,
    );
    if (value.kind !== 'resolved') return { kind: linkFailure(value.kind) };
    revision = value.link;
  }
  if (body.kind === 'live-work-finished' && body.outcomeReference) {
    const value = await totalLink(
      links,
      'receipt',
      body.outcomeReference,
      scope,
    );
    if (value.kind !== 'resolved') return { kind: linkFailure(value.kind) };
    outcomeLink = value.link;
  }
  return body.kind === 'live-work-started'
    ? {
        kind: 'resolved',
        body: {
          kind: body.kind,
          sessionId: body.sessionId,
          ...(run ? { run } : {}),
        },
      }
    : {
        kind: 'resolved',
        body: {
          kind: body.kind,
          sessionId: body.sessionId,
          outcome: body.outcome,
          ...(run ? { run } : {}),
          ...(revision ? { revision } : {}),
          ...(outcomeLink ? { outcomeLink } : {}),
        },
      };
}
function linkFailure(kind: 'unresolved' | 'unverified' | 'unavailable') {
  return kind === 'unresolved'
    ? ('link-unresolved' as const)
    : kind === 'unverified'
      ? ('link-unverified' as const)
      : ('unavailable' as const);
}
async function totalLink(
  links: ProjectTaskRoomLinkAuthority | undefined,
  kind: ProjectTaskRoomResolvedLink['kind'],
  reference: string,
  scope: ProjectTaskRoomScope,
): Promise<ProjectTaskRoomLinkResolution> {
  if (!links) return { kind: 'unavailable' };
  try {
    const value = await links.resolve({ kind, reference, scope });
    return validLinkResolution(value, kind)
      ? deepCloneFreeze(value)
      : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}
function validIntent(value: unknown): value is ProjectTaskRoomAppendIntent {
  if (!boundedPlain(value, PROJECT_TASK_ROOM_LIMITS.requestBytes)) return false;
  if (
    !isPlainOwn(value, [
      'proposalId',
      'occurredAt',
      'correlationId',
      'causationId',
      'body',
    ])
  )
    return false;
  const item = value as Record<string, unknown>;
  return (
    id(item.proposalId) &&
    id(item.occurredAt) &&
    optionalId(item.correlationId) &&
    optionalId(item.causationId) &&
    validAppendBody(item.body)
  );
}
function validAppendBody(value: unknown): value is ProjectTaskRoomAppendBody {
  if (
    !measureBoundedJson(value, {
      maxBytes: PROJECT_TASK_ROOM_LIMITS.bodyBytes,
      maxDepth: PROJECT_TASK_ROOM_LIMITS.jsonDepth,
      maxItems: PROJECT_TASK_ROOM_LIMITS.jsonItems,
      maxStringCodeUnits: PROJECT_TASK_ROOM_LIMITS.stringBytes,
      maxKeyCodeUnits: 64,
    }).ok ||
    !isPlainRecord(value)
  )
    return false;
  const kind = value.kind;
  if (kind === 'human-message')
    return isPlainOwn(value, ['kind', 'text']) && text(value.text);
  if (kind === 'live-work-started')
    return (
      isPlainOwn(value, ['kind', 'sessionId', 'runReference']) &&
      id(value.sessionId) &&
      optionalId(value.runReference)
    );
  if (kind === 'live-work-finished')
    return (
      isPlainOwn(value, [
        'kind',
        'sessionId',
        'outcome',
        'runReference',
        'revisionReference',
        'outcomeReference',
      ]) &&
      id(value.sessionId) &&
      ['completed', 'failed', 'cancelled'].includes(value.outcome as string) &&
      optionalId(value.runReference) &&
      optionalId(value.revisionReference) &&
      optionalId(value.outcomeReference)
    );
  if (kind === 'live-work-presence-ended')
    return (
      isPlainOwn(value, ['kind', 'sessionId', 'reason', 'runReference']) &&
      id(value.sessionId) &&
      ['departed', 'withdrawn', 'expired'].includes(value.reason as string) &&
      optionalId(value.runReference)
    );
  return (
    kind === 'outcome-link' &&
    isPlainOwn(value, ['kind', 'linkKind', 'reference']) &&
    ['run', 'revision', 'proposed-change', 'evidence', 'receipt'].includes(
      value.linkKind as string,
    ) &&
    id(value.reference)
  );
}
function validReadInput(cursor: unknown, limit: unknown) {
  if (
    limit !== undefined &&
    (!Number.isSafeInteger(limit) || Number(limit) < 1)
  )
    return false;
  if (cursor === undefined) return true;
  return (
    boundedPlain(cursor, 2048) &&
    isPlainOwn(cursor, [
      'schemaVersion',
      'channelId',
      'epoch',
      'throughSeq',
      'checkpointDigest',
      'retainedAnchorSeq',
      'retainedAnchorDigest',
      'afterSeq',
      'afterEnvelopeDigest',
      'afterCheckpointDigest',
    ]) &&
    (cursor as any).schemaVersion === 'station.project-task-room-cursor/v1' &&
    ['epoch', 'throughSeq', 'retainedAnchorSeq', 'afterSeq'].every(
      (key) =>
        Number.isSafeInteger((cursor as any)[key]) && (cursor as any)[key] >= 0,
    ) &&
    (cursor as any).retainedAnchorSeq <= (cursor as any).throughSeq &&
    ['channelId', 'checkpointDigest', 'retainedAnchorDigest'].every((key) =>
      id((cursor as any)[key]),
    ) &&
    ((cursor as any).afterEnvelopeDigest === null ||
      id((cursor as any).afterEnvelopeDigest)) &&
    id((cursor as any).afterCheckpointDigest)
  );
}
function validCapabilityResult(
  value: unknown,
  required: ProjectTaskRoomGrantKind,
): value is ProjectTaskRoomCapabilityResolution {
  if (
    !isPlainRecord(value) ||
    !['granted', 'not-found', 'denied', 'revoked', 'unavailable'].includes(
      value.kind as string,
    )
  )
    return false;
  if (value.kind !== 'granted') return isPlainOwn(value, ['kind']);
  const receipt = value.receipt;
  return (
    isPlainOwn(value, ['kind', 'receipt']) &&
    validCapabilityReceipt(receipt, required)
  );
}
function validCapabilityReceipt(
  value: unknown,
  expectedCapability?: ProjectTaskRoomGrantKind,
): value is ProjectTaskRoomCapabilityReceipt {
  return (
    isPlainOwn(value, [
      'receiptId',
      'capability',
      'scope',
      'principal',
      'policyRevision',
    ]) &&
    [
      'discover',
      'history-read',
      'message-write',
      'lifecycle-append',
      'revision-link',
      'agent-publish',
    ].includes(value.capability as string) &&
    (expectedCapability === undefined ||
      value.capability === expectedCapability) &&
    id(value.receiptId) &&
    id(value.policyRevision) &&
    validScope(value.scope) &&
    validPrincipal(value.principal)
  );
}
function validScope(value: unknown): value is ProjectTaskRoomScope {
  return (
    isPlainOwn(value, ['projectId', 'projectSlug', 'taskId']) &&
    id((value as any).projectId) &&
    id((value as any).projectSlug) &&
    id((value as any).taskId)
  );
}
function validPrincipal(value: unknown): value is ProjectTaskRoomPrincipal {
  return (
    isPlainRecord(value) &&
    (value.kind === 'operator'
      ? isPlainOwn(value, ['kind', 'operatorId', 'deviceId']) &&
        id(value.operatorId) &&
        id(value.deviceId)
      : value.kind === 'agent' &&
        isPlainOwn(value, [
          'kind',
          'agentId',
          'ownerOperatorId',
          'deviceId',
          'authorizationReceiptId',
        ]) &&
        id(value.agentId) &&
        id(value.ownerOperatorId) &&
        id(value.deviceId) &&
        id(value.authorizationReceiptId))
  );
}
function validAgentResolution(
  value: unknown,
): value is ProjectTaskRoomAgentResolution {
  return (
    isPlainRecord(value) &&
    ['authorized', 'denied', 'revoked', 'unavailable'].includes(
      value.kind as string,
    ) &&
    (value.kind === 'authorized'
      ? isPlainOwn(value, ['kind', 'principal']) &&
        validPrincipal(value.principal) &&
        value.principal.kind === 'agent'
      : isPlainOwn(value, ['kind']))
  );
}
function validLinkResolution(
  value: unknown,
  kind: string,
): value is ProjectTaskRoomLinkResolution {
  return (
    isPlainRecord(value) &&
    ['resolved', 'unresolved', 'unverified', 'unavailable'].includes(
      value.kind as string,
    ) &&
    (value.kind === 'resolved'
      ? isPlainOwn(value, ['kind', 'link']) &&
        isPlainOwn(value.link, [
          'schemaVersion',
          'kind',
          'stableId',
          'digest',
          'authorityReceiptId',
        ]) &&
        value.link.schemaVersion ===
          'station.project-task-room-resolved-link/v1' &&
        value.link.kind === kind &&
        id(value.link.stableId) &&
        id(value.link.digest) &&
        id(value.link.authorityReceiptId)
      : isPlainOwn(value, ['kind']))
  );
}
function isGrant(
  value: unknown,
): value is ProjectTaskRoomGrant<ProjectTaskRoomGrantKind> {
  try {
    return (
      Object.isFrozen(value) &&
      isPlainOwn(value, ['schemaVersion', 'capability', 'opaqueToken']) &&
      (value as any).schemaVersion === 'station.project-task-room-grant/v1' &&
      [
        'discover',
        'history-read',
        'message-write',
        'lifecycle-append',
        'revision-link',
        'agent-publish',
      ].includes((value as any).capability) &&
      id((value as any).opaqueToken)
    );
  } catch {
    return false;
  }
}
function isKind(value: unknown, kind: string): value is { kind: string } {
  return isPlainOwn(value, ['kind']) && (value as any).kind === kind;
}
function isCloseOutcome(value: unknown): value is ProjectTaskRoomCloseOutcome {
  return (
    isPlainOwn(value, ['kind']) &&
    ['closed', 'pending', 'unavailable'].includes(value.kind as string)
  );
}
function isAppendStorage(
  value: unknown,
  expected: { proposalId: string; proposalDigest: string; channelId: string },
): value is any {
  if (
    !isPlainRecord(value) ||
    ![
      'committed',
      'duplicate',
      'conflict',
      'capacity',
      'denied',
      'unavailable',
    ].includes(value.kind as string)
  )
    return false;
  if (value.kind === 'committed' || value.kind === 'duplicate')
    return (
      isPlainOwn(value, ['kind', 'receipt']) &&
      validReceipt(value.receipt) &&
      value.receipt.proposalId === expected.proposalId &&
      value.receipt.proposalDigest === expected.proposalDigest &&
      value.receipt.coordinate.channelId === expected.channelId &&
      value.receipt.checkpoint.channelId === expected.channelId &&
      value.receipt.coordinate.seq === value.receipt.checkpoint.throughSeq
    );
  return isPlainOwn(value, ['kind']);
}
function isReadStorage(
  value: unknown,
  expected: {
    scope: ProjectTaskRoomScope;
    channelId: string;
    cursor?: import('@kontourai/station-contracts/project-task-room').ProjectTaskRoomCursor;
    receipt: ProjectTaskRoomCapabilityReceipt;
  },
): value is ProjectTaskRoomReadOutcome {
  if (
    !boundedPlain(
      value,
      PROJECT_TASK_ROOM_LIMITS.pageBytes,
      PROJECT_TASK_ROOM_MAX_PAGE_JSON_ITEMS,
    ) ||
    !isPlainRecord(value) ||
    !['available', 'stale', 'gap', 'denied', 'unavailable'].includes(
      value.kind as string,
    )
  )
    return false;
  if (value.kind === 'denied' || value.kind === 'unavailable')
    return isPlainOwn(value, ['kind']);
  if (value.kind === 'stale')
    return (
      isPlainOwn(value, ['kind', 'checkpoint']) &&
      (value.checkpoint === undefined ||
        (validCheckpoint(value.checkpoint) &&
          value.checkpoint.channelId === expected.channelId))
    );
  if (value.kind === 'gap')
    return (
      isPlainOwn(value, [
        'kind',
        'missingThroughSeq',
        'checkpoint',
        'resumeCursor',
      ]) &&
      Number.isSafeInteger(value.missingThroughSeq) &&
      value.missingThroughSeq >= 0 &&
      validCheckpoint(value.checkpoint) &&
      value.checkpoint.channelId === expected.channelId &&
      value.checkpoint.retainedAnchorSeq === value.missingThroughSeq &&
      validReadInput(value.resumeCursor, undefined) &&
      value.resumeCursor.channelId === expected.channelId &&
      value.resumeCursor.epoch === value.checkpoint.epoch &&
      value.resumeCursor.throughSeq === value.checkpoint.throughSeq &&
      value.resumeCursor.checkpointDigest ===
        value.checkpoint.checkpointDigest &&
      value.resumeCursor.retainedAnchorSeq === value.missingThroughSeq &&
      value.resumeCursor.retainedAnchorDigest ===
        value.checkpoint.retainedAnchorDigest &&
      value.resumeCursor.afterSeq ===
        Math.min(
          value.resumeCursor.retainedAnchorSeq,
          value.resumeCursor.throughSeq,
        ) &&
      (value.resumeCursor.afterSeq !== value.resumeCursor.retainedAnchorSeq ||
        (value.resumeCursor.afterCheckpointDigest ===
          value.resumeCursor.retainedAnchorDigest &&
          (value.resumeCursor.afterSeq === 0
            ? value.resumeCursor.afterEnvelopeDigest === null
            : value.resumeCursor.afterEnvelopeDigest !== null))) &&
      (!expected.cursor ||
        (value.checkpoint.throughSeq === expected.cursor.throughSeq &&
          value.checkpoint.checkpointDigest ===
            expected.cursor.checkpointDigest))
    );
  if (
    !isPlainOwn(value, [
      'kind',
      'records',
      'checkpoint',
      'hasMore',
      'nextCursor',
      'integrity',
    ]) ||
    !Array.isArray(value.records) ||
    value.records.length > PROJECT_TASK_ROOM_LIMITS.pageRecords ||
    !validCheckpoint(value.checkpoint) ||
    value.checkpoint.channelId !== expected.channelId ||
    (expected.cursor !== undefined &&
      (value.checkpoint.throughSeq !== expected.cursor.throughSeq ||
        value.checkpoint.checkpointDigest !==
          expected.cursor.checkpointDigest)) ||
    typeof value.hasMore !== 'boolean' ||
    value.integrity !== 'L0'
  )
    return false;
  const startAfter =
    expected.cursor?.afterSeq ?? value.checkpoint.retainedAnchorSeq;
  let previousEnvelope = expected.cursor?.afterEnvelopeDigest ?? null;
  let rolling =
    expected.cursor?.afterCheckpointDigest ??
    value.checkpoint.retainedAnchorDigest;
  for (let index = 0; index < value.records.length; index += 1) {
    const record = value.records[index];
    if (
      !validRecord(record) ||
      !recordMatchesAuthority(record, expected) ||
      record.envelope.seq !== startAfter + index + 1 ||
      record.envelope.prevEnvelopeDigest !== previousEnvelope
    )
      return false;
    const envelopeDigest = sha(canonical(record.envelope));
    rolling = sha(`${rolling}\u0000${envelopeDigest}`);
    if (record.checkpointDigest !== rolling) return false;
    previousEnvelope = envelopeDigest;
  }
  const lastSeq = value.records.at(-1)?.envelope.seq ?? startAfter;
  if (value.hasMore) {
    if (
      value.records.length === 0 ||
      lastSeq >= value.checkpoint.throughSeq ||
      !value.nextCursor ||
      !validReadInput(value.nextCursor, undefined) ||
      value.nextCursor.channelId !== expected.channelId ||
      value.nextCursor.epoch !== value.checkpoint.epoch ||
      value.nextCursor.throughSeq !== value.checkpoint.throughSeq ||
      value.nextCursor.checkpointDigest !== value.checkpoint.checkpointDigest ||
      value.nextCursor.retainedAnchorSeq !==
        value.checkpoint.retainedAnchorSeq ||
      value.nextCursor.retainedAnchorDigest !==
        value.checkpoint.retainedAnchorDigest ||
      value.nextCursor.afterSeq !== lastSeq ||
      value.nextCursor.afterEnvelopeDigest !== previousEnvelope ||
      value.nextCursor.afterCheckpointDigest !== rolling
    )
      return false;
  } else if (
    value.nextCursor !== undefined ||
    lastSeq !== value.checkpoint.throughSeq ||
    rolling !== value.checkpoint.checkpointDigest
  )
    return false;
  return true;
}
function validReceipt(value: unknown) {
  return (
    boundedPlain(value, 4_096) &&
    isPlainOwn(value, [
      'schemaVersion',
      'proposalId',
      'proposalDigest',
      'envelopeDigest',
      'coordinate',
      'checkpoint',
      'committedAt',
      'assurance',
    ]) &&
    value.schemaVersion === 'station.project-task-room-append-receipt/v1' &&
    id(value.proposalId) &&
    id(value.proposalDigest) &&
    id(value.envelopeDigest) &&
    id(value.committedAt) &&
    value.assurance === 'L0' &&
    isPlainOwn(value.coordinate, ['channelId', 'epoch', 'seq']) &&
    id(value.coordinate.channelId) &&
    Number.isSafeInteger(value.coordinate.epoch) &&
    value.coordinate.epoch >= 0 &&
    Number.isSafeInteger(value.coordinate.seq) &&
    value.coordinate.seq >= 1 &&
    validCheckpoint(value.checkpoint) &&
    value.checkpoint.epoch === value.coordinate.epoch
  );
}
function validCheckpoint(value: unknown) {
  return (
    isPlainOwn(value, [
      'channelId',
      'epoch',
      'throughSeq',
      'checkpointDigest',
      'retainedAnchorSeq',
      'retainedAnchorDigest',
    ]) &&
    id(value.channelId) &&
    ['epoch', 'throughSeq', 'retainedAnchorSeq'].every(
      (key) => Number.isSafeInteger(value[key]) && value[key] >= 0,
    ) &&
    id(value.checkpointDigest) &&
    id(value.retainedAnchorDigest) &&
    value.retainedAnchorSeq <= value.throughSeq
  );
}
function validRecord(
  value: unknown,
): value is import('@kontourai/station-contracts/project-task-room').ProjectTaskRoomRecord {
  if (
    !boundedPlain(value, PROJECT_TASK_ROOM_LIMITS.requestBytes, 500) ||
    !isPlainOwn(value, [
      'schemaVersion',
      'scope',
      'principal',
      'correlationId',
      'causationId',
      'envelope',
      'body',
      'bodyBytes',
      'checkpointDigest',
    ]) ||
    value.schemaVersion !== 'station.project-task-room/v2' ||
    !validScope(value.scope) ||
    !validPrincipal(value.principal) ||
    !optionalId(value.correlationId) ||
    !optionalId(value.causationId) ||
    !isPlainRecord(value.envelope) ||
    !validStoredBody(value.body) ||
    !Number.isSafeInteger(value.bodyBytes) ||
    value.bodyBytes < 0 ||
    !id(value.checkpointDigest)
  )
    return false;
  const bodyMeasure = measureBoundedJson(value.body, {
    maxBytes: PROJECT_TASK_ROOM_LIMITS.bodyBytes,
    maxDepth: PROJECT_TASK_ROOM_LIMITS.jsonDepth,
    maxItems: PROJECT_TASK_ROOM_LIMITS.jsonItems,
    maxStringCodeUnits: PROJECT_TASK_ROOM_LIMITS.stringBytes,
    maxKeyCodeUnits: 64,
  });
  const envelope = value.envelope;
  const payload = envelope.proposal?.body;
  return (
    bodyMeasure.ok &&
    bodyMeasure.bytes === value.bodyBytes &&
    validateChannelSequencingEnvelope(envelope).ok &&
    sha(channelProposalDigestInput(envelope.proposal)) ===
      envelope.proposalDigest &&
    isPlainOwn(payload, [
      'schemaVersion',
      'scope',
      'principal',
      'body',
      'correlationId',
      'causationId',
      'grantReceipt',
    ]) &&
    payload.schemaVersion === 'station.project-task-room-proposal/v1' &&
    canonical(payload.scope) === canonical(value.scope) &&
    canonical(payload.principal) === canonical(value.principal) &&
    canonical(payload.body) === canonical(value.body) &&
    payload.correlationId === value.correlationId &&
    payload.causationId === value.causationId
  );
}
function recordMatchesAuthority(
  record: import('@kontourai/station-contracts/project-task-room').ProjectTaskRoomRecord,
  expected: {
    scope: ProjectTaskRoomScope;
    channelId: string;
    receipt: ProjectTaskRoomCapabilityReceipt;
  },
) {
  const proposal = record.envelope.proposal;
  const payload = proposal.body;
  const expectedGrantCapability: ProjectTaskRoomGrantKind =
    record.principal.kind === 'agent'
      ? 'agent-publish'
      : record.body.kind === 'human-message'
        ? 'message-write'
        : record.body.kind === 'outcome-link'
          ? 'revision-link'
          : 'lifecycle-append';
  if (
    canonical(record.scope) !== canonical(expected.scope) ||
    record.envelope.channelId !== expected.channelId ||
    !isPlainRecord(payload) ||
    !validCapabilityReceipt(payload.grantReceipt, expectedGrantCapability) ||
    canonical(payload.scope) !== canonical(record.scope) ||
    canonical(payload.principal) !== canonical(record.principal) ||
    canonical(payload.grantReceipt.scope) !== canonical(record.scope) ||
    canonical(payload.grantReceipt.principal) !== canonical(record.principal) ||
    payload.grantReceipt.policyRevision !== record.envelope.policyRevision
  )
    return false;
  if (record.principal.kind === 'operator')
    return (
      proposal.kind === 'message' &&
      proposal.onBehalfOf === undefined &&
      proposal.author.memberId === record.principal.operatorId &&
      proposal.author.deviceId === record.principal.deviceId &&
      proposal.author.keyId === 'station-local-l0'
    );
  return (
    proposal.kind === 'agent-action' &&
    proposal.author.memberId === record.principal.ownerOperatorId &&
    proposal.author.deviceId === record.principal.deviceId &&
    proposal.author.keyId === record.principal.agentId &&
    proposal.onBehalfOf?.ownerMemberId === record.principal.ownerOperatorId &&
    proposal.onBehalfOf.authorizationId ===
      record.principal.authorizationReceiptId
  );
}
function validStoredBody(value: unknown): value is ProjectTaskRoomBody {
  if (!isPlainRecord(value)) return false;
  if (value.kind === 'human-message')
    return isPlainOwn(value, ['kind', 'text']) && text(value.text);
  if (value.kind === 'live-work-started')
    return (
      isPlainOwn(value, ['kind', 'sessionId', 'run']) &&
      id(value.sessionId) &&
      (value.run === undefined || validResolvedLink(value.run, 'run'))
    );
  if (value.kind === 'live-work-presence-ended')
    return (
      isPlainOwn(value, ['kind', 'sessionId', 'reason', 'run']) &&
      id(value.sessionId) &&
      ['departed', 'withdrawn', 'expired'].includes(value.reason as string) &&
      (value.run === undefined || validResolvedLink(value.run, 'run'))
    );
  if (value.kind === 'live-work-finished')
    return (
      isPlainOwn(value, [
        'kind',
        'sessionId',
        'outcome',
        'run',
        'revision',
        'outcomeLink',
      ]) &&
      id(value.sessionId) &&
      ['completed', 'failed', 'cancelled'].includes(value.outcome as string) &&
      (value.run === undefined || validResolvedLink(value.run, 'run')) &&
      (value.revision === undefined ||
        validResolvedLink(value.revision, 'revision')) &&
      (value.outcomeLink === undefined ||
        validResolvedLink(value.outcomeLink, 'receipt'))
    );
  return (
    value.kind === 'outcome-link' &&
    isPlainOwn(value, ['kind', 'link']) &&
    validResolvedLink(value.link)
  );
}
function validResolvedLink(value: unknown, exactKind?: string) {
  return (
    isPlainOwn(value, [
      'schemaVersion',
      'kind',
      'stableId',
      'digest',
      'authorityReceiptId',
    ]) &&
    value.schemaVersion === 'station.project-task-room-resolved-link/v1' &&
    ['run', 'revision', 'proposed-change', 'evidence', 'receipt'].includes(
      value.kind as string,
    ) &&
    (exactKind === undefined || value.kind === exactKind) &&
    id(value.stableId) &&
    id(value.digest) &&
    id(value.authorityReceiptId)
  );
}
function isPlainRecord(value: unknown): value is Record<string, any> {
  return plainDataObject(value);
}
function isPlainOwn(
  value: unknown,
  allowed: readonly string[],
): value is Record<string, any> {
  if (!isPlainRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.every((key) => typeof key === 'string' && allowed.includes(key)) &&
    keys.length === Object.keys(value).length
  );
}
function boundedPlain(
  value: unknown,
  maxBytes: number,
  maxItems: number = PROJECT_TASK_ROOM_LIMITS.jsonItems,
) {
  return measureBoundedJson(value, {
    maxBytes,
    maxDepth: PROJECT_TASK_ROOM_LIMITS.jsonDepth,
    maxItems,
    maxStringCodeUnits: PROJECT_TASK_ROOM_LIMITS.stringBytes,
    maxKeyCodeUnits: 256,
  }).ok;
}
function id(value: unknown) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= PROJECT_TASK_ROOM_LIMITS.idBytes &&
    new TextEncoder().encode(value).byteLength <=
      PROJECT_TASK_ROOM_LIMITS.idBytes &&
    isWellFormed(value)
  );
}
function text(value: unknown) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= PROJECT_TASK_ROOM_LIMITS.stringBytes &&
    new TextEncoder().encode(value).byteLength <=
      PROJECT_TASK_ROOM_LIMITS.stringBytes &&
    isWellFormed(value)
  );
}
function optionalId(value: unknown) {
  return value === undefined || id(value);
}
function isWellFormed(value: string) {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    value,
  );
}
function channelIdFor(scope: ProjectTaskRoomScope) {
  return `project-task:${sha(`${scope.projectId}\u0000${scope.taskId}`)}`;
}
function sha(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function canonical(value: unknown): string {
  return JSON.stringify(sort(value));
}
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sort((value as any)[key])]),
    );
  return value;
}
function deepCloneFreeze<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (item: any) => {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(clone);
}
function observe(
  operation: string,
  outcome: string,
  started: number,
  pageRecords?: number,
) {
  projectTaskRoomHistoryOperations.add(1, { operation, outcome });
  projectTaskRoomHistoryDuration.record(performance.now() - started, {
    operation,
    outcome,
  });
  if (pageRecords !== undefined)
    projectTaskRoomHistoryPageRecords.record(pageRecords, { outcome });
}
