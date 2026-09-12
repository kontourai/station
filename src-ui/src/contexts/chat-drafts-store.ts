import type { FileAttachment } from '../types';
import {
  MAX_DRAFT_QUOTES,
  parseSavedAnswerQuote,
  type SavedAnswerQuote,
} from '../utils/answer-quotes';

const CHAT_DRAFTS_STORAGE_KEY = 'station:chat-drafts:v1';
const MAX_DRAFTS = 20;
const MAX_DRAFT_LENGTH = 20_000;
const MAX_STASHED_IMAGES = 5;

interface StoredDraft {
  quotes?: SavedAnswerQuote[];
  text: string;
  updatedAt: number;
}

type StoredDrafts = Record<string, StoredDraft>;

/** Deliberately has no model, engine, provider, or connection field. */
export interface PortableDraft {
  quotes?: SavedAnswerQuote[];
  id: string;
  name: string;
  text: string;
  createdAt: number;
  attachments: FileAttachment[];
  droppedImageNames: string[];
  unreadableImageNames: string[];
}

interface StoredState {
  sessions: StoredDrafts;
  portable: PortableDraft[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readSessionDrafts(value: unknown): StoredDrafts {
  if (!isRecord(value)) return {};
  const result: StoredDrafts = {};
  for (const [sessionId, candidateValue] of Object.entries(value)) {
    if (!isRecord(candidateValue)) continue;
    if (
      typeof candidateValue.text !== 'string' ||
      typeof candidateValue.updatedAt !== 'number'
    )
      continue;
    result[sessionId] = {
      text: candidateValue.text.slice(0, MAX_DRAFT_LENGTH),
      ...(Array.isArray(candidateValue.quotes)
        ? {
            quotes: candidateValue.quotes
              .map(parseSavedAnswerQuote)
              .filter((quote): quote is SavedAnswerQuote => quote !== null)
              .slice(0, MAX_DRAFT_QUOTES),
          }
        : {}),
      updatedAt: candidateValue.updatedAt,
    };
  }
  return Object.fromEntries(
    Object.entries(result)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_DRAFTS),
  );
}

function readState(): StoredState {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(CHAT_DRAFTS_STORAGE_KEY) || '{}',
    ) as unknown;
    // The original v1 value was the session-id map itself. Keep reading it.
    if (!isRecord(parsed) || !('sessions' in parsed)) {
      return { sessions: readSessionDrafts(parsed), portable: [] };
    }
    const portable = Array.isArray(parsed.portable)
      ? parsed.portable.filter((draft): draft is PortableDraft => {
          if (!isRecord(draft)) return false;
          return (
            typeof draft.id === 'string' &&
            typeof draft.name === 'string' &&
            typeof draft.text === 'string' &&
            typeof draft.createdAt === 'number' &&
            Array.isArray(draft.attachments) &&
            Array.isArray(draft.droppedImageNames) &&
            Array.isArray(draft.unreadableImageNames)
          );
        })
      : [];
    return {
      sessions: readSessionDrafts(parsed.sessions),
      portable: portable
        .map((draft) => ({
          ...draft,
          ...(Array.isArray(draft.quotes)
            ? {
                quotes: draft.quotes
                  .map(parseSavedAnswerQuote)
                  .filter((quote): quote is SavedAnswerQuote => quote !== null)
                  .slice(0, MAX_DRAFT_QUOTES),
              }
            : {}),
        }))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_DRAFTS),
    };
  } catch {
    return { sessions: {}, portable: [] };
  }
}

function writeState(state: StoredState): void {
  try {
    window.localStorage.setItem(CHAT_DRAFTS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Draft persistence is best-effort when localStorage is unavailable/full.
  }
}

const EMPTY_QUOTES: readonly SavedAnswerQuote[] = [];
let state = readState();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export type DraftAttachmentEncoder = (
  attachment: FileAttachment,
) => Promise<FileAttachment>;

export const chatDraftsStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): Readonly<StoredDrafts> {
    return state.sessions;
  },
  getPortableSnapshot(): readonly PortableDraft[] {
    return state.portable;
  },
  get(sessionId: string): string {
    return state.sessions[sessionId]?.text ?? '';
  },
  getQuotes(sessionId: string): readonly SavedAnswerQuote[] {
    return state.sessions[sessionId]?.quotes ?? EMPTY_QUOTES;
  },
  addQuote(sessionId: string, quote: SavedAnswerQuote): void {
    const current = state.sessions[sessionId];
    const quotes = current?.quotes ?? [];
    if (!parseSavedAnswerQuote(quote)) throw new Error('Invalid quote');
    if (quotes.length >= MAX_DRAFT_QUOTES)
      throw new Error(
        'Remove a quote before adding another. A draft can hold three quotes.',
      );
    state = {
      ...state,
      sessions: {
        ...state.sessions,
        [sessionId]: {
          text: current?.text ?? '',
          updatedAt: Date.now(),
          quotes: [...quotes, quote],
        },
      },
    };
    state = {
      ...state,
      sessions: Object.fromEntries(
        Object.entries(state.sessions)
          .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
          .slice(0, MAX_DRAFTS),
      ),
    };
    writeState(state);
    notify();
  },
  consumeQuotes(sessionId: string, sent: readonly SavedAnswerQuote[]): void {
    const current = state.sessions[sessionId];
    if (!current) return;
    state = {
      ...state,
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...current,
          quotes: (current.quotes ?? []).filter(
            (quote) => !sent.includes(quote),
          ),
        },
      },
    };
    writeState(state);
    notify();
  },
  removeQuote(sessionId: string, index: number): void {
    const current = state.sessions[sessionId];
    if (!current) return;
    state = {
      ...state,
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...current,
          quotes: (current.quotes ?? []).filter((_, i) => i !== index),
        },
      },
    };
    writeState(state);
    notify();
  },
  hasDraft(sessionId: string): boolean {
    return Boolean(
      state.sessions[sessionId]?.text.trim() ||
        state.sessions[sessionId]?.quotes?.length,
    );
  },
  set(sessionId: string, text: string): void {
    if (!text && !state.sessions[sessionId]?.quotes?.length) {
      if (!(sessionId in state.sessions)) return;
      const { [sessionId]: _removed, ...sessions } = state.sessions;
      state = { ...state, sessions };
      writeState(state);
      notify();
      return;
    }
    state = {
      ...state,
      sessions: Object.fromEntries(
        Object.entries({
          ...state.sessions,
          [sessionId]: {
            quotes: state.sessions[sessionId]?.quotes,
            text: text.slice(0, MAX_DRAFT_LENGTH),
            updatedAt: Date.now(),
          },
        })
          .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
          .slice(0, MAX_DRAFTS),
      ),
    };
    writeState(state);
    notify();
  },
  clear(sessionId: string): void {
    if (!(sessionId in state.sessions)) return;
    const { [sessionId]: _removed, ...sessions } = state.sessions;
    state = { ...state, sessions };
    writeState(state);
    notify();
  },
  async stash(
    name: string,
    text: string,
    attachments: readonly FileAttachment[],
    encode: DraftAttachmentEncoder = async (attachment) => attachment,
    quotes: readonly SavedAnswerQuote[] = [],
  ): Promise<PortableDraft> {
    const createdAt = Date.now();
    const id = `draft-${createdAt}`;
    const images = attachments.filter((item) => item.type.startsWith('image/'));
    const files = attachments.filter((item) => !item.type.startsWith('image/'));
    const kept = images.slice(0, MAX_STASHED_IMAGES);
    const draft: PortableDraft = {
      id,
      name: name.trim() || text.trim().slice(0, 48) || 'Untitled draft',
      text: text.slice(0, MAX_DRAFT_LENGTH),
      createdAt,
      attachments: [...files],
      ...(quotes.length
        ? {
            quotes: quotes
              .map(parseSavedAnswerQuote)
              .filter((quote): quote is SavedAnswerQuote => quote !== null)
              .slice(0, MAX_DRAFT_QUOTES),
          }
        : {}),
      droppedImageNames: images
        .slice(MAX_STASHED_IMAGES)
        .map((item) => item.name),
      unreadableImageNames: [],
    };
    // Ordering guarantee: words are durable before image work can begin.
    state = {
      ...state,
      portable: [draft, ...state.portable].slice(0, MAX_DRAFTS),
    };
    writeState(state);
    notify();
    for (const attachment of kept) {
      try {
        draft.attachments.push(await encode(attachment));
      } catch {
        draft.unreadableImageNames.push(attachment.name);
      }
      state = {
        ...state,
        portable: state.portable.map((item) =>
          item.id === id ? { ...draft } : item,
        ),
      };
      writeState(state);
      notify();
    }
    return draft;
  },
  clearPortable(): void {
    if (state.portable.length === 0) return;
    state = { ...state, portable: [] };
    writeState(state);
    notify();
  },
};

export {
  CHAT_DRAFTS_STORAGE_KEY,
  MAX_DRAFT_LENGTH,
  MAX_DRAFTS,
  MAX_STASHED_IMAGES,
};
