const CHAT_DRAFTS_STORAGE_KEY = 'station:chat-drafts:v1';
const MAX_DRAFTS = 20;
const MAX_DRAFT_LENGTH = 20_000;

interface StoredDraft {
  text: string;
  updatedAt: number;
}

type StoredDrafts = Record<string, StoredDraft>;

function readDrafts(): StoredDrafts {
  try {
    const raw = window.localStorage.getItem(CHAT_DRAFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    const drafts: StoredDrafts = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const candidate = value as Partial<StoredDraft>;
      if (
        typeof candidate.text !== 'string' ||
        typeof candidate.updatedAt !== 'number'
      )
        continue;
      drafts[sessionId] = {
        text: candidate.text.slice(0, MAX_DRAFT_LENGTH),
        updatedAt: candidate.updatedAt,
      };
    }
    return Object.fromEntries(
      Object.entries(drafts)
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(0, MAX_DRAFTS),
    );
  } catch {
    return {};
  }
}

function writeDrafts(drafts: StoredDrafts): void {
  try {
    window.localStorage.setItem(
      CHAT_DRAFTS_STORAGE_KEY,
      JSON.stringify(drafts),
    );
  } catch {
    // Draft persistence is best-effort when localStorage is unavailable/full.
  }
}

let drafts = readDrafts();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Local chat text is bounded to 20 session drafts of at most 20,000 chars each. */
export const chatDraftsStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): Readonly<StoredDrafts> {
    return drafts;
  },
  hasDraft(sessionId: string): boolean {
    return Boolean(drafts[sessionId]?.text.trim());
  },
  get(sessionId: string): string {
    return drafts[sessionId]?.text ?? '';
  },
  set(sessionId: string, text: string): void {
    if (!text) {
      if (!(sessionId in drafts)) return;
      const { [sessionId]: _removed, ...remaining } = drafts;
      drafts = remaining;
      writeDrafts(drafts);
      notify();
      return;
    }
    drafts = Object.fromEntries(
      Object.entries({
        ...drafts,
        [sessionId]: {
          text: text.slice(0, MAX_DRAFT_LENGTH),
          updatedAt: Date.now(),
        },
      })
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(0, MAX_DRAFTS),
    );
    writeDrafts(drafts);
    notify();
  },
  clear(sessionId: string): void {
    if (!(sessionId in drafts)) return;
    const { [sessionId]: _removed, ...remaining } = drafts;
    drafts = remaining;
    writeDrafts(drafts);
    notify();
  },
};

export { CHAT_DRAFTS_STORAGE_KEY, MAX_DRAFT_LENGTH, MAX_DRAFTS };
