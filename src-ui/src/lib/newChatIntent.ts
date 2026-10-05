import type { NewChatModelChoice } from '../utils/modelCapabilities';

export const OPEN_NEW_CHAT_EVENT = 'station:open-new-chat';

/**
 * What a start composer's chips chose: the context (a project slug, or
 * `GLOBAL_CONTEXT`), the Agent, and this start's Model choice (provider and
 * runtime options included). Home's composer sends it with its start, so the
 * dock starts exactly what Home's chips showed.
 */
export interface NewChatStartSelection {
  context: string;
  agentSlug?: string;
  model?: NewChatModelChoice;
}

/** The setup routes an Agent row can repair through (`AgentFixRoute`). */
const NEW_CHAT_HANDOFF_ROUTES = [
  'models',
  'enable',
  'engines',
  'edit',
] as const;
export type NewChatHandoffRoute = (typeof NEW_CHAT_HANDOFF_ROUTES)[number];

/**
 * Work Home's composer cannot finish in place because it leaves the page: a
 * setup journey and visual skills run from the dock's composer, which stays
 * mounted while setup is open and returns to the draft afterwards.
 */
export type NewChatHandoff =
  | { kind: 'repair'; agentSlug: string; route: NewChatHandoffRoute }
  /** Set up a connection when there is no Agent yet to repair. */
  | { kind: 'connections' }
  | { kind: 'skills' };

/** How the dock's New chat closed: a chat started, or it was dismissed. */
export type NewChatClosedOutcome = 'started' | 'dismissed';

export interface NewChatIntent {
  /** Start at once with `selection` (or the defaults), sending the prompt. */
  startWithDefault?: boolean;
  initialPrompt?: string;
  selection?: NewChatStartSelection;
  /**
   * The intent carried a selection that did not parse. The dock opens the
   * composer with the message and says so, never a default start.
   */
  selectionInvalid?: boolean;
  /** Open the draft with the prompt and selection, then run this. */
  handoff?: NewChatHandoff;
  /**
   * How the request ended. A dismissal also hands back the dock's draft text
   * as it last read (the person may have edited it there).
   */
  onClosed?: (outcome: NewChatClosedOutcome, draft?: string) => void;
}

/**
 * Dispatch a new-chat intent and report whether a dock took it. Docks call
 * `preventDefault()` on an intent they accept; with no dock listening (no
 * region holds the Chat pane) or only a project-scoped dock, nobody does,
 * and the sender must keep its draft.
 */
export function dispatchNewChatIntent(detail: NewChatIntent): boolean {
  return !window.dispatchEvent(
    new CustomEvent<NewChatIntent>(OPEN_NEW_CHAT_EVENT, {
      detail,
      cancelable: true,
    }),
  );
}

/**
 * Whether a dock takes this intent. Home's starts, selections and hand-offs
 * belong to the ambient dock: a dock scoped to one project would run them in
 * the wrong project, so it leaves them for the ambient one.
 */
export function dockAcceptsNewChatIntent(
  intent: NewChatIntent,
  hasImmutableProjectScope: boolean,
): boolean {
  if (!hasImmutableProjectScope) return true;
  return !(
    intent.startWithDefault ||
    intent.handoff ||
    intent.selection ||
    intent.selectionInvalid
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** `undefined` when absent; `null` when present but not a non-empty string. */
function optionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' && value ? value : null;
}

/** A malformed selection is refused whole, never partly applied. */
function readSelection(value: unknown): NewChatStartSelection | undefined {
  if (!isRecord(value)) return undefined;
  const { context, agentSlug, model } = value;
  if (typeof context !== 'string' || !context) return undefined;
  const slug = optionalString(agentSlug);
  if (slug === null) return undefined;
  let choice: NewChatModelChoice | undefined;
  if (model !== undefined) {
    if (!isRecord(model) || !isRecord(model.providerOptions)) return undefined;
    const modelId = optionalString(model.modelId);
    const providerId = optionalString(model.providerId);
    const providerType = optionalString(model.providerType);
    if (modelId === null || providerId === null || providerType === null)
      return undefined;
    choice = {
      ...(modelId ? { modelId } : {}),
      ...(providerId ? { providerId } : {}),
      ...(providerType ? { providerType } : {}),
      providerOptions: { ...model.providerOptions },
    };
  }
  return {
    context,
    ...(slug ? { agentSlug: slug } : {}),
    ...(choice ? { model: choice } : {}),
  };
}

function readHandoff(value: unknown): NewChatHandoff | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'skills') return { kind: 'skills' };
  if (value.kind === 'connections') return { kind: 'connections' };
  const route = NEW_CHAT_HANDOFF_ROUTES.find((entry) => entry === value.route);
  if (
    value.kind === 'repair' &&
    typeof value.agentSlug === 'string' &&
    value.agentSlug &&
    route
  )
    return { kind: 'repair', agentSlug: value.agentSlug, route };
  return undefined;
}

export function readNewChatIntent(event: Event): NewChatIntent {
  const detail: unknown =
    event instanceof CustomEvent ? event.detail : undefined;
  if (!detail || typeof detail !== 'object') return {};
  const prompt = 'initialPrompt' in detail ? detail.initialPrompt : undefined;
  const callback = 'onClosed' in detail ? detail.onClosed : undefined;
  const selection =
    'selection' in detail ? readSelection(detail.selection) : undefined;
  // A selection that was sent but does not parse is not "no selection": the
  // start it came with must not quietly run on the dock's defaults.
  const selectionInvalid = 'selection' in detail && !selection;
  const handoff = 'handoff' in detail ? readHandoff(detail.handoff) : undefined;
  return {
    startWithDefault:
      !selectionInvalid &&
      'startWithDefault' in detail &&
      detail.startWithDefault === true,
    initialPrompt: typeof prompt === 'string' ? prompt : undefined,
    ...(selection ? { selection } : {}),
    ...(selectionInvalid ? { selectionInvalid: true } : {}),
    ...(handoff ? { handoff } : {}),
    onClosed:
      typeof callback === 'function'
        ? (outcome: NewChatClosedOutcome, draft?: string) =>
            callback(outcome, draft)
        : undefined,
  };
}
