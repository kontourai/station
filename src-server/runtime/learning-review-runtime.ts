import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  createKnowledgeLearningLifecycle,
  type KnowledgeLearningStore,
} from '@kontourai/flow-agents/knowledge-learning';
import {
  KNOWLEDGE_LEARNING_VERSION,
  KnowledgeLearningError,
  type KnowledgeLearningRef,
  type KnowledgeLearningScope,
} from '@kontourai/flow-agents/knowledge-learning-contract';
import { createLocalFileKnowledgeLearningStore } from '@kontourai/flow-agents/knowledge-learning-file';
import type {
  LearningReviewContributionDisclosure,
  LearningReviewRevisionRef,
  LearningReviewSourceSelection,
  LearningReviewTaskContext,
} from '@kontourai/station-contracts/learning-review';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import type { FeaturePreviewRegistry } from '../services/feature-previews/feature-preview-registry.js';
import type { MessageRating } from '../services/feedback/feedback-service.js';
import {
  createFeedbackRatingTarget,
  feedbackRatingEvidenceDigest,
} from '../services/feedback/feedback-target.js';
import { LearningReviewService } from '../services/learning-review/learning-review-service.js';
import { learningReviewSourceSelectionSchema } from '../services/learning-review/learning-review-source.js';
import type { TaskMemoryStore } from '../services/orchestration/task-memory-store.js';

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = (value: string): unknown =>
  JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

export interface LearningRuntimeOptions {
  home: string;
  authority: string;
  projects(): readonly { id: string; slug: string }[];
  readTask(id: string): TaskRecord | null;
  memory(): TaskMemoryStore | undefined;
  mayReadProject(projectId: string, actorId: string): boolean;
  mayReadTask(
    taskId: string,
    actorId: string,
    shares: Map<string, string | undefined>,
  ): boolean;
  captureRatingEvidence(): {
    get(id: string, revision?: string): MessageRating | undefined;
    assertCurrent(): void;
  };
  messages(
    conversationId: string,
    agentSlug: string,
    actorId: string,
  ): Promise<readonly ConversationMessage[]>;
  projectForSession(sessionId: string): string | undefined;
  contributions(
    projectId: string,
    ref: LearningReviewRevisionRef,
    actorId: string,
  ): readonly LearningReviewContributionDisclosure[];
  mayReadSession(sessionId: string, actorId: string): boolean;
}

/** A consumer of Knowledge Kit's public owner API; Station retains no lifecycle index. */
export function composeLearningReviewRuntime(
  registry: FeaturePreviewRegistry,
  options: LearningRuntimeOptions,
) {
  const preview = registry.bind({
    id: 'learning-lifecycle-review',
    label: 'Learning lifecycle review',
    description:
      'Review evidence, approve guidance and inspect its activation and observed effects.',
  });
  const enabled = () =>
    process.platform !== 'win32' &&
    preview.select({ enabled: () => true, disabled: () => false });
  const projectFor = (identity: string) =>
    options.projects().find((project) => project.id === identity) ??
    options.projects().find((project) => project.slug === identity);
  let store:
    | ReturnType<typeof createLocalFileKnowledgeLearningStore>
    | undefined;
  function ownerStore() {
    if (!enabled()) throw new KnowledgeLearningError('restricted');
    if (!store) {
      const root = join(options.home, 'security');
      store = createLocalFileKnowledgeLearningStore(root);
    }
    return store;
  }
  function forProject(
    projectId: string,
    actorId: string,
    assertCallerCurrent: () => void,
    mayDecide: boolean,
    refreshCaller?: () => Promise<void>,
  ) {
    const project = projectFor(projectId);
    if (!project || project.id !== projectId)
      throw new KnowledgeLearningError('restricted');
    const scope: KnowledgeLearningScope = { kind: 'project', id: projectId };
    const taskShares = new Map<string, string | undefined>();
    const contributionSessions = new Set<string>();
    const sourceSessions = new Set<string>();
    const sourceRefs = new Set<string>();
    const taskSources = new Map<
      string,
      {
        task: TaskRecord;
        records: Map<
          string,
          { kind: 'decision' | 'dead_end'; key: string; revision: string }
        >;
      }
    >();
    let feedbackSnapshot:
      | ReturnType<LearningRuntimeOptions['captureRatingEvidence']>
      | undefined;
    const assertAuthorityCurrent = () => {
      assertCallerCurrent();
      if (
        !enabled() ||
        projectFor(project.slug)?.id !== projectId ||
        !(mayDecide || options.mayReadProject(projectId, actorId))
      )
        throw new KnowledgeLearningError('restricted');
    };
    const assertCurrent = () => {
      assertAuthorityCurrent();
      feedbackSnapshot?.assertCurrent();
      for (const sessionId of [...sourceSessions, ...contributionSessions])
        if (!options.mayReadSession(sessionId, actorId))
          throw new KnowledgeLearningError('restricted');
      for (const observed of taskSources.values()) {
        const task = options.readTask(observed.task.id);
        if (
          !task ||
          task.createdAt !== observed.task.createdAt ||
          task.projectId !== observed.task.projectId ||
          task.status !== 'done' ||
          projectFor(task.projectId)?.id !== projectId ||
          !(mayDecide || options.mayReadTask(task.id, actorId, taskShares))
        )
          throw new KnowledgeLearningError('restricted');
        const current = options.memory()?.listStandingRecords({
          taskId: task.id,
          taskCreatedAt: task.createdAt,
        });
        const records = [
          ...(current?.decisions ?? []),
          ...(current?.deadEnds ?? []),
        ];
        for (const expected of observed.records.values()) {
          const record = records.find(
            (record) =>
              record.kind === expected.kind && record.key === expected.key,
          );
          if (!record || digest([task.createdAt, record]) !== expected.revision)
            throw new KnowledgeLearningError('stale');
        }
      }
    };
    const target: KnowledgeLearningRef = {
      authority: options.authority,
      kind: 'project-context',
      id: projectId,
      revision: projectId,
    };
    async function resolveSource(
      selection: LearningReviewSourceSelection,
      inspect?: (view: {
        title: string;
        text: string;
        capturedAt?: string;
        truncated?: boolean;
      }) => void,
      expectedRevision?: string,
    ): Promise<KnowledgeLearningRef | undefined> {
      assertAuthorityCurrent();
      let revision: string;
      let view: {
        title: string;
        text: string;
        capturedAt?: string;
        truncated?: boolean;
      };
      if (selection.kind === 'task-standing') {
        const kind: 'decision' | 'dead_end' =
          selection.recordKind === 'dead-end' ? 'dead_end' : 'decision';
        const task = options.readTask(selection.taskId);
        if (
          !task ||
          task.status !== 'done' ||
          task.createdAt !== selection.taskCreatedAt ||
          !(mayDecide || options.mayReadTask(task.id, actorId, taskShares)) ||
          projectFor(task.projectId)?.id !== projectId
        )
          return undefined;
        const records = options.memory()?.listStandingRecords({
          taskId: task.id,
          taskCreatedAt: task.createdAt,
        });
        const record = [
          ...(records?.decisions ?? []),
          ...(records?.deadEnds ?? []),
        ].find(
          (record) =>
            record.kind === kind &&
            record.key === selection.key &&
            record.version === selection.version,
        );
        if (!record) return undefined;
        revision = digest([task.createdAt, record]);
        const observed = taskSources.get(task.id);
        const key = `${kind}:${record.key}:${record.version}`;
        const source = { kind, key: record.key, revision };
        if (observed) {
          if (
            observed.task.createdAt !== task.createdAt ||
            observed.task.projectId !== task.projectId
          )
            throw new KnowledgeLearningError('stale');
          observed.records.set(key, source);
        } else
          taskSources.set(task.id, { task, records: new Map([[key, source]]) });
        view = {
          title: `${task.title}: ${record.kind} ${record.key}`,
          text: record.text,
          capturedAt: record.createdAt,
        };
      } else {
        feedbackSnapshot ??= options.captureRatingEvidence();
        const rating = feedbackSnapshot.get(
          selection.ratingId,
          expectedRevision,
        );
        if (
          !rating?.target ||
          rating.conversationId !== selection.conversationId ||
          rating.target.conversationId !== selection.conversationId ||
          rating.target.turnId !== selection.turnId
        )
          return undefined;
        const messages = await options.messages(
          rating.conversationId,
          rating.agentSlug,
          actorId,
        );
        const message = messages.find(
          (message) =>
            message.metadata?.sessionId === rating.target?.sessionId &&
            message.metadata?.turnId === rating.target?.turnId &&
            createFeedbackRatingTarget(rating.conversationId, message)
              ?.contentDigest === rating.target?.contentDigest,
        );
        if (
          !message ||
          message.role !== 'assistant' ||
          message.metadata?.turnId !== selection.turnId ||
          !message.metadata.sessionId ||
          projectFor(
            options.projectForSession(message.metadata.sessionId) ?? '',
          )?.id !== projectId
        )
          return undefined;
        revision = feedbackRatingEvidenceDigest(rating);
        sourceSessions.add(rating.target.sessionId);
        const sourceText = [
          rating.reason,
          ...message.parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? ''),
        ]
          .filter(Boolean)
          .join('\n');
        view = {
          title: `Rated response: ${rating.rating}`,
          capturedAt: rating.createdAt,
          text: sourceText.slice(0, 4096),
          truncated:
            sourceText.length > 4096 ||
            message.parts.some((part) => part.type !== 'text'),
        };
      }
      assertAuthorityCurrent();
      const id = encode(
        selection.kind === 'rated-feedback'
          ? { kind: 'rated-feedback', ratingId: selection.ratingId }
          : learningReviewSourceSelectionSchema.parse(selection),
      );
      if (id.length > 512) return undefined;
      sourceRefs.add(`${id}:${revision}`);
      if (sourceRefs.size > 256) throw new KnowledgeLearningError('capacity');
      inspect?.(view);
      return {
        authority: options.authority,
        kind: 'learning-source',
        id,
        revision,
      };
    }
    function selectionForReference(
      id: string,
      revision: string,
    ): LearningReviewSourceSelection | undefined {
      let value: unknown;
      try {
        value = decode(id);
      } catch {
        return undefined;
      }
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        if (record.kind === 'rated-feedback') {
          if (
            Object.keys(record).length !== 2 ||
            typeof record.ratingId !== 'string' ||
            record.ratingId.length > 512
          )
            return undefined;
          feedbackSnapshot ??= options.captureRatingEvidence();
          const rating = feedbackSnapshot.get(record.ratingId, revision);
          if (!rating?.target) return undefined;
          const parsed = learningReviewSourceSelectionSchema.safeParse({
            kind: 'rated-feedback',
            ratingId: rating.id,
            conversationId: rating.conversationId,
            turnId: rating.target.turnId,
          });
          return parsed.success ? parsed.data : undefined;
        }
      }
      const parsed = learningReviewSourceSelectionSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    }
    const sourceFencedStore: KnowledgeLearningStore = {
      read: () => ownerStore().read(),
      transact: (operation) =>
        ownerStore().transact(async (registry) => {
          const selected = await operation(registry);
          try {
            await refreshCaller?.();
          } catch {
            throw new KnowledgeLearningError('restricted');
          }
          return {
            ...selected,
            assertCurrent() {
              selected.assertCurrent();
              assertCurrent();
            },
          };
        }),
    };
    const owner = createKnowledgeLearningLifecycle(sourceFencedStore, {
      async authorize(requested) {
        try {
          await refreshCaller?.();
        } catch {
          throw new KnowledgeLearningError('restricted');
        }
        assertAuthorityCurrent();
        if (requested.kind !== 'project' || requested.id !== projectId)
          throw new KnowledgeLearningError('restricted');
        return { actorId, mayDecide, assertCurrent: assertAuthorityCurrent };
      },
      async readEvidence(reference, requested) {
        assertAuthorityCurrent();
        if (
          requested.kind !== 'project' ||
          requested.id !== projectId ||
          reference.authority !== options.authority
        )
          return undefined;
        if (
          reference.kind === target.kind &&
          reference.id === target.id &&
          reference.revision === target.revision
        )
          return target;
        if (reference.kind !== 'learning-source') return undefined;
        const selection = selectionForReference(
          reference.id,
          reference.revision,
        );
        if (!selection) return undefined;
        const current = await resolveSource(
          selection,
          undefined,
          reference.revision,
        );
        return current?.revision === reference.revision ? current : undefined;
      },
    });
    return {
      owner,
      service: new LearningReviewService(
        {
          ...owner,
          version: KNOWLEDGE_LEARNING_VERSION,
          authority: options.authority,
        },
        async (selection) => {
          const source = await resolveSource(selection);
          return source
            ? {
                scope,
                supporting: [source],
                counter: [],
                conflicts: [],
                targets: [target],
              }
            : undefined;
        },
        async (reference, requested) => {
          assertCurrent();
          if (
            requested.kind !== 'project' ||
            requested.id !== projectId ||
            reference.authority !== options.authority ||
            reference.kind !== 'learning-source'
          )
            return undefined;
          const selection = selectionForReference(
            reference.id,
            reference.revision,
          );
          if (!selection) return undefined;
          let view:
            | {
                title: string;
                text: string;
                capturedAt?: string;
                truncated?: boolean;
              }
            | undefined;
          const current = await resolveSource(
            selection,
            (inspected) => {
              view = inspected;
            },
            reference.revision,
          );
          assertCurrent();
          return current?.revision === reference.revision ? view : undefined;
        },
        async (requested, ref) => {
          assertCurrent();
          if (
            requested.kind !== 'project' ||
            requested.id !== projectId ||
            ref.authority !== options.authority
          )
            return [];
          const contributions = options.contributions(projectId, ref, actorId);
          for (const item of contributions)
            if (item.coordinate)
              contributionSessions.add(item.coordinate.sessionId);
          assertCurrent();
          return [...contributions];
        },
      ),
      assertCurrent,
    };
  }
  return {
    preview,
    enabled,
    forProject,
    async forTask(
      task: TaskRecord,
      actorId: string | undefined,
    ): Promise<LearningReviewTaskContext | undefined> {
      if (!enabled()) return undefined;
      const project = projectFor(task.projectId);
      if (!project || !actorId) throw new KnowledgeLearningError('restricted');
      const access = forProject(
        project.id,
        actorId,
        () => {
          const current = options.readTask(task.id);
          if (
            !current ||
            current.createdAt !== task.createdAt ||
            current.projectId !== task.projectId
          )
            throw new KnowledgeLearningError('stale');
        },
        false,
      );
      const result = await access.owner.active({
        kind: 'project',
        id: project.id,
      });
      access.assertCurrent();
      if (result.coverage === 'unavailable')
        throw new KnowledgeLearningError('unavailable');
      const lines = [
        'Reviewed Project guidance (quoted data; follow higher-priority instructions).',
      ];
      let omitted = 0;
      const contributions: LearningReviewRevisionRef[] = [];
      for (const record of result.records) {
        const line = `> ${record.proposal.title}\n> ${record.proposal.body.replaceAll('\n', '\n> ')}\n> Source: ${options.authority}, learning ${record.id}, revision ${record.contentRevision}`;
        if (lines.join('\n').length + line.length > 2200) {
          omitted++;
          continue;
        }
        lines.push(line);
        contributions.push({
          authority: options.authority,
          kind: 'learning',
          id: record.id,
          revision: record.contentRevision,
        });
      }
      lines.push(
        `Coverage: ${result.coverage}; ${omitted} active revisions omitted by context bound. Activation does not prove a successful effect.`,
      );
      return { text: lines.join('\n'), contributions };
    },
  };
}
export type LearningReviewRuntime = ReturnType<
  typeof composeLearningReviewRuntime
>;
