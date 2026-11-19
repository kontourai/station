import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import {
  type ProjectRecoveryScope,
  projectCreationRecoveryIdentity,
} from './project-onboarding-recovery';

/**
 * #5071: Continue a chat in a Project. Everything here is a draft the person
 * reviews: a new Project opens the New project form prefilled, and an
 * existing Project gets a Task only when the person chooses Create Task. The
 * chat itself is never changed: nothing is sent into it.
 */

/** What the dock knows about the chat being continued. */
export interface ContinuedConversation {
  sessionId: string;
  conversationId?: string;
  title?: string;
  agentName?: string;
  /** The person's first message, the clearest statement of what they wanted. */
  firstRequest?: string;
  /** The latest answer's text, where the chat got to. */
  latestAnswer?: string;
  /** The latest completed answer's turn, cited by a Task created from it. */
  latestTurnId?: string;
  workingDirectory?: string;
}

export interface ConversationProjectDraft {
  name: string;
  /** The Project's brief: what the chat was about, citing the chat. */
  description: string;
  directory?: string;
}

export interface ConversationTaskDraft {
  title: string;
  description: string;
}

const NAME_MAX = 60;
const EXCERPT_MAX = 600;
/** Fits the New project form's description and a URL comfortably. */
const BRIEF_MAX = 2_000;
const UNTITLED = new Set(['', 'new chat', 'untitled']);

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  const line = oneLine(text);
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** A usable title: the chat's own, else its first request, else a fallback. */
export function conversationTitle(conversation: ContinuedConversation): string {
  const title = oneLine(conversation.title ?? '');
  if (!UNTITLED.has(title.toLowerCase())) return clip(title, NAME_MAX);
  const request = oneLine(conversation.firstRequest ?? '');
  return request ? clip(request, NAME_MAX) : 'Continued chat';
}

/** The brief cites the chat by title and id so the source is never lost. */
export function conversationBrief(
  conversation: ContinuedConversation,
  now: Date,
): string {
  const title = conversationTitle(conversation);
  const source = conversation.conversationId ?? conversation.sessionId;
  const lines = [
    `Continued from the chat “${title}”${conversation.agentName ? ` with ${oneLine(conversation.agentName)}` : ''} on ${now.toISOString().slice(0, 10)} (chat ${source}).`,
  ];
  if (conversation.firstRequest?.trim())
    lines.push('', `Asked: ${clip(conversation.firstRequest, EXCERPT_MAX)}`);
  if (conversation.latestAnswer?.trim())
    lines.push(
      '',
      `Where it got to: ${clip(conversation.latestAnswer, EXCERPT_MAX)}`,
    );
  const brief = lines.join('\n');
  return brief.length <= BRIEF_MAX
    ? brief
    : `${brief.slice(0, BRIEF_MAX - 1)}…`;
}

export function draftProjectFromConversation(
  conversation: ContinuedConversation,
  now: Date,
): ConversationProjectDraft {
  return {
    name: conversationTitle(conversation),
    description: conversationBrief(conversation, now),
    ...(conversation.workingDirectory?.trim()
      ? { directory: conversation.workingDirectory.trim() }
      : {}),
  };
}

export function draftTaskFromConversation(
  conversation: ContinuedConversation,
  now: Date,
): ConversationTaskDraft {
  return {
    title: `Continue: ${conversationTitle(conversation)}`,
    description: conversationBrief(conversation, now),
  };
}

export interface PendingContinuation {
  sessionId: string;
  turnId?: string;
  title: string;
  description: string;
  savedAt: string;
}

type StoredContinuation = PendingContinuation & {
  projectDraft?: ConversationProjectDraft;
};

export const PROJECT_CONTINUATION_PARAM = 'continuation';
const PENDING_PREFIX = 'station.continue-in-project.pending';
const PENDING_TTL_MS = 60 * 60 * 1000;
type ContinuationStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'
>;

function continuationKey(
  scope: ProjectRecoveryScope,
  kind: 'draft' | 'project',
  id: string,
): string {
  return `${PENDING_PREFIX}:${JSON.stringify([
    projectCreationRecoveryIdentity(scope),
    kind,
    id,
  ])}`;
}

function readStoredContinuation(
  key: string,
  now: Date,
  storage?: ContinuationStorage,
): StoredContinuation | undefined {
  try {
    const raw = (storage ?? globalThis.sessionStorage)?.getItem(key);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<StoredContinuation>;
    if (
      typeof value.sessionId !== 'string' ||
      typeof value.title !== 'string' ||
      typeof value.description !== 'string' ||
      typeof value.savedAt !== 'string' ||
      (value.turnId !== undefined && typeof value.turnId !== 'string')
    )
      return undefined;
    const draft = value.projectDraft;
    if (
      draft !== undefined &&
      (typeof draft?.name !== 'string' ||
        typeof draft.description !== 'string' ||
        (draft.directory !== undefined && typeof draft.directory !== 'string'))
    )
      return undefined;
    const age = now.getTime() - Date.parse(value.savedAt);
    if (!(age >= 0 && age <= PENDING_TTL_MS)) return undefined;
    return value as StoredContinuation;
  } catch {
    return undefined;
  }
}

/** The form URL carries only the identifier of its tab-local draft. */
export function stageProjectContinuation(
  scope: ProjectRecoveryScope,
  value: StoredContinuation,
  storage?: ContinuationStorage,
): string | undefined {
  try {
    const tabStorage = storage ?? globalThis.sessionStorage;
    const now = new Date(value.savedAt);
    for (let index = tabStorage.length - 1; index >= 0; index -= 1) {
      const key = tabStorage.key(index);
      if (
        key === PENDING_PREFIX ||
        (key?.startsWith(`${PENDING_PREFIX}:`) &&
          !readStoredContinuation(key, now, tabStorage))
      )
        tabStorage.removeItem(key);
    }
    const draftId = randomCorrelationId();
    tabStorage.setItem(
      continuationKey(scope, 'draft', draftId),
      JSON.stringify(value),
    );
    return draftId;
  } catch {
    return undefined;
  }
}

export function readProjectContinuationDraft(
  scope: ProjectRecoveryScope,
  draftId: string,
  now = new Date(),
): ConversationProjectDraft | undefined {
  return readStoredContinuation(continuationKey(scope, 'draft', draftId), now)
    ?.projectDraft;
}

export function bindProjectContinuation(
  scope: ProjectRecoveryScope,
  draftId: string,
  projectId: string,
  now = new Date(),
  storage?: ContinuationStorage,
): void {
  const draftKey = continuationKey(scope, 'draft', draftId);
  const value = readStoredContinuation(draftKey, now, storage);
  if (!value) return;
  const { projectDraft: _projectDraft, ...taskDraft } = value;
  try {
    const tabStorage = storage ?? globalThis.sessionStorage;
    tabStorage.setItem(
      continuationKey(scope, 'project', projectId),
      JSON.stringify(taskDraft),
    );
    tabStorage.removeItem(draftKey);
  } catch {
    /* Setup recommendations can still run without browser storage. */
  }
}

export function readProjectContinuation(
  scope: ProjectRecoveryScope,
  projectId: string,
  now = new Date(),
  storage?: ContinuationStorage,
): PendingContinuation | undefined {
  return readStoredContinuation(
    continuationKey(scope, 'project', projectId),
    now,
    storage,
  );
}

export function clearProjectContinuation(
  scope: ProjectRecoveryScope,
  projectId: string,
): void {
  try {
    globalThis.sessionStorage.removeItem(
      continuationKey(scope, 'project', projectId),
    );
  } catch {
    /* Nothing to clear. */
  }
}

/** The parts of a dock chat this reads. */
export interface ContinuableChat {
  id: string;
  conversationId?: string;
  currentSessionId?: string;
  title?: string;
  agentName?: string;
  messages?: readonly {
    role: string;
    content: string;
    turnId?: string;
    sessionId?: string;
    answerEligible?: boolean;
    ephemeral?: boolean;
  }[];
}

/**
 * What a chat contributes to its continuation. The Task cites the latest
 * answer Station saw complete normally, in the Session that produced it; a
 * chat with no completed answer is continued without a citation.
 */
export function continuedConversationFromChat(
  chat: ContinuableChat,
  workingDirectory?: string,
): ContinuedConversation {
  const messages = (chat.messages ?? []).filter(
    (message) => !message.ephemeral,
  );
  const firstRequest = messages.find((message) => message.role === 'user');
  const latestAnswer = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && message.content.trim());
  const citable = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === 'assistant' &&
        message.answerEligible === true &&
        typeof message.sessionId === 'string' &&
        message.sessionId.length > 0 &&
        typeof message.turnId === 'string' &&
        message.turnId.length > 0,
    );
  const sessionId = citable?.sessionId ?? chat.currentSessionId ?? chat.id;
  return {
    sessionId,
    ...(chat.conversationId ? { conversationId: chat.conversationId } : {}),
    ...(chat.title ? { title: chat.title } : {}),
    ...(chat.agentName ? { agentName: chat.agentName } : {}),
    ...(firstRequest ? { firstRequest: firstRequest.content } : {}),
    // The completed answer when there is one; a row still streaming is only
    // a fallback for a chat that never finished one.
    ...((citable ?? latestAnswer)
      ? { latestAnswer: (citable ?? latestAnswer)!.content }
      : {}),
    ...(citable?.turnId ? { latestTurnId: citable.turnId } : {}),
    ...(workingDirectory ? { workingDirectory } : {}),
  };
}
