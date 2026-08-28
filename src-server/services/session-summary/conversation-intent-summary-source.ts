import type {
  ConversationIntentSummaryRange,
  ConversationIntentSummaryRelatedEvidenceRef,
  ConversationIntentSummaryVerificationRef,
} from '@kontourai/station-contracts/conversation-intent-summary';
import { CONVERSATION_INTENT_SUMMARY_MAX_ITEMS } from '@kontourai/station-contracts/conversation-intent-summary';
import { parseTaskTurnReference } from '@kontourai/station-contracts/task-graph';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import {
  CONTEXT_BOUNDARY_OMISSION_MARKER,
  conversationIntentRevision,
  SESSION_SUMMARY_MESSAGE_MAX_CHARS,
  SESSION_SUMMARY_TRANSCRIPT_MAX_CHARS,
  textOf,
} from '../../routes/chat/session-summary-generation.js';

/** A server-only observation. The model never supplies or upgrades this. */
export type SummaryRelatedEvidenceObservation =
  | {
      kind: 'task-turn';
      taskId: string;
      turnId: string;
      eventId: string;
      authorized: true;
    }
  | { kind: 'task-turn'; authorized: false; revoked?: boolean };

export interface ConversationIntentSummarySourceInput {
  messages: ConversationMessage[];
  /** Snapshot watermark from the bounded event window, not a live tail. */
  watermark?: number | string;
  /** Only consumed archive#4148 markers belong in a derived-source revision. */
  consumedBoundaries?: readonly {
    boundaryId: string;
    policy: 'continue-from-history' | 'empty-next-cold-start';
    priorTranscriptInjected: boolean;
  }[];
  /** Already authority-filtered, bounded reverse lookup results. */
  relatedEvidenceObservations?: readonly SummaryRelatedEvidenceObservation[];
}

export interface ConversationIntentSummarySource {
  messages: ConversationMessage[];
  transcript: string;
  ranges: ConversationIntentSummaryRange[];
  partialMessageIncluded: boolean;
  contextBoundaryCount: number;
  relatedEvidenceRefs: ConversationIntentSummaryRelatedEvidenceRef[];
  /** No Task/turn pointer becomes verification without a Basis fact. */
  verificationRefs: ConversationIntentSummaryVerificationRef[];
  contextBoundaries: NonNullable<
    ConversationIntentSummarySourceInput['consumedBoundaries']
  >;
  revision: string;
}

const MAX_SUMMARY_TASKS = CONVERSATION_INTENT_SUMMARY_MAX_ITEMS;
const MAX_TASK_TURN_LINKS = CONVERSATION_INTENT_SUMMARY_MAX_ITEMS;
const RECENT_COMPLETE_TURN_LIMIT = 8;

/**
 * Bounded reverse catalog of Task -> turn links. It never trusts a model
 * suggestion: a ref is admitted only when the requested conversation event
 * window observed the exact completed turn and the existing answer seam still
 * authorizes that tuple under this request's authority.
 */
export function createConversationIntentSummaryEvidenceCatalog(input: {
  taskGraph: {
    listTasks(): readonly { id: string }[];
    readTaskTurnReferenceScope(taskId: string): { projectId: string } | null;
    readTaskTurnReferenceLinks(
      taskId: string,
    ): readonly { id: string; targetId: string }[] | null;
  };
  sessionQueries: {
    readAssistantTurn(
      query: { type: 'assistant-turn'; threadId: string; turnId: string },
      authority: SessionReadAuthority,
    ): Promise<
      | { status: 'found'; projectSlug?: string }
      | { status: 'not-found' | 'unavailable' }
    >;
  };
}) {
  return {
    async observe(inputValue: {
      authority: SessionReadAuthority;
      events: readonly {
        event: {
          eventId: string;
          threadId: string;
          turnId?: string;
          method: string;
        };
      }[];
    }): Promise<SummaryRelatedEvidenceObservation[]> {
      const observed = new Map<string, string>();
      for (const { event } of inputValue.events) {
        if (event.method !== 'turn.completed' || !event.turnId) continue;
        observed.set(`${event.threadId}\u0000${event.turnId}`, event.eventId);
      }
      if (observed.size === 0) return [];
      const admitted = new Map<string, SummaryRelatedEvidenceObservation>();
      for (const task of input.taskGraph
        .listTasks()
        .slice(0, MAX_SUMMARY_TASKS)) {
        const scope = input.taskGraph.readTaskTurnReferenceScope(task.id);
        const links = input.taskGraph.readTaskTurnReferenceLinks(task.id);
        if (!scope || !links || links.length > MAX_TASK_TURN_LINKS) continue;
        for (const link of links) {
          const tuple = parseTaskTurnReference(link.targetId);
          if (!tuple) continue;
          const eventId = observed.get(
            `${tuple.sessionId}\u0000${tuple.turnId}`,
          );
          if (!eventId) continue;
          const answer = await input.sessionQueries.readAssistantTurn(
            {
              type: 'assistant-turn',
              threadId: tuple.sessionId,
              turnId: tuple.turnId,
            },
            inputValue.authority,
          );
          if (
            answer.status !== 'found' ||
            (answer.projectSlug !== undefined &&
              answer.projectSlug !== scope.projectId)
          )
            continue;
          const key = `${task.id}\u0000${tuple.sessionId}\u0000${tuple.turnId}`;
          admitted.set(key, {
            kind: 'task-turn',
            taskId: task.id,
            turnId: tuple.turnId,
            eventId,
            authorized: true,
          });
        }
      }
      return [...admitted.values()];
    },
  };
}

function cap(text: string): string {
  if (text.length <= SESSION_SUMMARY_MESSAGE_MAX_CHARS) return text;
  const head = Math.ceil(SESSION_SUMMARY_MESSAGE_MAX_CHARS / 2);
  return `${text.slice(0, head)}\n[…truncated…]\n${text.slice(
    -(SESSION_SUMMARY_MESSAGE_MAX_CHARS - head),
  )}`;
}

function roleText(message: ConversationMessage): string | undefined {
  if (message.role !== 'user' && message.role !== 'assistant') return undefined;
  const text = textOf(message).trim();
  return text
    ? `${message.role === 'user' ? 'User' : 'Assistant'}: ${cap(text)}`
    : undefined;
}

function ranges(
  selected: readonly { message: ConversationMessage; index: number }[],
): ConversationIntentSummaryRange[] {
  if (!selected.length) return [];
  const output: ConversationIntentSummaryRange[] = [];
  let start = selected[0]!;
  let previous = start;
  for (const item of selected.slice(1)) {
    if (item.index === previous.index + 1) {
      previous = item;
      continue;
    }
    output.push({
      fromMessageId: start.message.id,
      throughMessageId: previous.message.id,
      messageCount: previous.index - start.index + 1,
    });
    start = item;
    previous = item;
  }
  output.push({
    fromMessageId: start.message.id,
    throughMessageId: previous.message.id,
    messageCount: previous.index - start.index + 1,
  });
  return output;
}

/**
 * The authoritative, intentionally small source selection. It consumes only
 * authorized role/text transcript material and server observations; tool,
 * attachment, metadata, UI and model-provided references never cross here.
 */
export class AuthoritativeConversationIntentSummarySource {
  read(
    input: ConversationIntentSummarySourceInput,
  ): ConversationIntentSummarySource {
    const turns = input.messages
      .map((message, index) => ({ message, index, text: roleText(message) }))
      .filter(
        (
          turn,
        ): turn is {
          message: ConversationMessage;
          index: number;
          text: string;
        } => Boolean(turn.text),
      );
    const boundaries = (input.consumedBoundaries ?? []).slice(
      0,
      CONVERSATION_INTENT_SUMMARY_MAX_ITEMS,
    );
    const structural = boundaries
      .filter((boundary) => boundary.policy === 'empty-next-cold-start')
      .map(() => CONTEXT_BOUNDARY_OMISSION_MARKER);
    // Reserve the exact structural facts first. The transcript bound applies
    // to the complete model input, not merely message content.
    const structuralText = structural.join('\n\n');
    let used = structuralText.length;
    const firstGoal = turns.find((turn) => turn.message.role === 'user');
    const selected: typeof turns = [];
    const selectedIds = new Set<string>();
    const add = (turn: (typeof turns)[number]) => {
      const separator = selected.length || structuralText ? 2 : 0;
      if (
        used + separator + turn.text.length >
        SESSION_SUMMARY_TRANSCRIPT_MAX_CHARS
      )
        return false;
      used += separator + turn.text.length;
      selected.push(turn);
      selectedIds.add(turn.message.id);
      return true;
    };
    // The first user goal gets first claim on the budget; newest complete
    // turns fill the remainder in canonical order.
    if (firstGoal) add(firstGoal);
    let recentCount = 0;
    for (const turn of [...turns].reverse()) {
      if (selected.length >= CONVERSATION_INTENT_SUMMARY_MAX_ITEMS) break;
      if (selectedIds.has(turn.message.id)) continue;
      if (recentCount >= RECENT_COMPLETE_TURN_LIMIT) break;
      if (add(turn)) recentCount += 1;
    }
    selected.sort((left, right) => left.index - right.index);
    const included = selected.map((turn) => turn.message);
    const relatedEvidenceRefs: ConversationIntentSummaryRelatedEvidenceRef[] = (
      input.relatedEvidenceObservations ?? []
    )
      .slice(0, CONVERSATION_INTENT_SUMMARY_MAX_ITEMS)
      .flatMap((observation) =>
        observation.authorized
          ? [
              {
                kind: 'task-turn',
                taskId: observation.taskId,
                turnId: observation.turnId,
                eventId: observation.eventId,
              },
            ]
          : [],
      );
    const verificationRefs: ConversationIntentSummaryVerificationRef[] = [
      {
        kind: 'task-turn',
        state: 'unavailable',
        unavailableReason: 'not-captured-by-station',
      },
    ];
    const revision = conversationIntentRevision(input.messages, {
      boundaries: boundaries.map(
        (boundary) =>
          `${boundary.boundaryId}:${boundary.policy}:${boundary.priorTranscriptInjected}`,
      ),
      verificationRefs: relatedEvidenceRefs.map((ref) => ({
        ...ref,
        state: 'related',
      })),
      watermark: input.watermark,
    });
    return {
      messages: included,
      transcript: [...selected.map((turn) => turn.text), ...structural].join(
        '\n\n',
      ),
      ranges: ranges(selected),
      partialMessageIncluded: false,
      contextBoundaryCount: boundaries.length,
      contextBoundaries: boundaries,
      relatedEvidenceRefs,
      verificationRefs,
      revision,
    };
  }
}
