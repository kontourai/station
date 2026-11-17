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

/** The New project form, opened with the draft filled in. */
export function newProjectHref(draft: ConversationProjectDraft): string {
  const params = new URLSearchParams();
  params.set('name', draft.name);
  params.set('description', draft.description);
  if (draft.directory) params.set('directory', draft.directory);
  return `/projects/new?${params.toString()}`;
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

/**
 * A continuation waiting for its new Project. The next new, empty Project's
 * Setup recommendations offer a Task that cites the chat (toggled, like every
 * recommendation); nothing is created until the person applies them. Kept per
 * browser tab, for an hour.
 */
export interface PendingContinuation {
  sessionId: string;
  turnId?: string;
  title: string;
  description: string;
  savedAt: string;
}

const PENDING_KEY = 'station.continue-in-project.pending';
/** A continuation older than this was abandoned. */
const PENDING_TTL_MS = 60 * 60 * 1000;

export function rememberPendingContinuation(
  value: PendingContinuation,
  storage: Pick<Storage, 'setItem'> | undefined = globalThis.sessionStorage,
): void {
  try {
    storage?.setItem(PENDING_KEY, JSON.stringify(value));
  } catch {
    /* Storage refused: the Project still opens; the card offers no chat Task. */
  }
}

export function readPendingContinuation(
  now: Date,
  storage: Pick<Storage, 'getItem'> | undefined = globalThis.sessionStorage,
): PendingContinuation | undefined {
  try {
    const raw = storage?.getItem(PENDING_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<PendingContinuation>;
    if (
      typeof value.sessionId !== 'string' ||
      typeof value.title !== 'string' ||
      typeof value.description !== 'string' ||
      typeof value.savedAt !== 'string' ||
      (value.turnId !== undefined && typeof value.turnId !== 'string')
    )
      return undefined;
    const age = now.getTime() - Date.parse(value.savedAt);
    if (!(age >= 0 && age <= PENDING_TTL_MS)) return undefined;
    return value as PendingContinuation;
  } catch {
    return undefined;
  }
}

export function clearPendingContinuation(
  storage: Pick<Storage, 'removeItem'> | undefined = globalThis.sessionStorage,
): void {
  try {
    storage?.removeItem(PENDING_KEY);
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
