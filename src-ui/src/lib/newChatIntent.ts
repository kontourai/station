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
export const NEW_CHAT_HANDOFF_ROUTES = [
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

export interface NewChatIntent {
  /** Start at once with `selection` (or the defaults), sending the prompt. */
  startWithDefault?: boolean;
  initialPrompt?: string;
  selection?: NewChatStartSelection;
  /** Open the draft with the prompt and selection, then run this. */
  handoff?: NewChatHandoff;
  onClosed?: () => void;
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
  const handoff = 'handoff' in detail ? readHandoff(detail.handoff) : undefined;
  return {
    startWithDefault:
      'startWithDefault' in detail && detail.startWithDefault === true,
    initialPrompt: typeof prompt === 'string' ? prompt : undefined,
    ...(selection ? { selection } : {}),
    ...(handoff ? { handoff } : {}),
    onClosed: typeof callback === 'function' ? () => callback() : undefined,
  };
}
