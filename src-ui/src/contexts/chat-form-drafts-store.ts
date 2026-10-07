import { activeChatsStore } from './active-chats-store';

interface FormDraft {
  values: Record<string, string | boolean>;
  status: 'editing' | 'sending' | 'submitted' | 'unconfirmed';
  error?: string;
}

const drafts = new Map<string, Map<string, FormDraft>>();
const listeners = new Map<string, Set<() => void>>();

function notify(scope: string) {
  for (const listener of listeners.get(scope) ?? []) listener();
}

// Form drafts outlive transcript rows, but closing the owning chat retires them.
activeChatsStore.onChatRemoved((chatKey) => {
  for (const scope of drafts.keys()) {
    if (JSON.parse(scope)[1] !== chatKey) continue;
    drafts.delete(scope);
    notify(scope);
  }
});

export const chatFormDraftsStore = {
  scope(apiBase: string, chatKey: string, conversationId?: string) {
    return JSON.stringify([apiBase, chatKey, conversationId ?? chatKey]);
  },
  get(scope: string | undefined, key: string) {
    return scope ? drafts.get(scope)?.get(key) : undefined;
  },
  subscribe(scope: string | undefined, listener: () => void) {
    if (!scope) return () => {};
    let subscribers = listeners.get(scope);
    if (!subscribers) {
      subscribers = new Set();
      listeners.set(scope, subscribers);
    }
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
      if (!subscribers.size) listeners.delete(scope);
    };
  },
  set(scope: string, key: string, draft: FormDraft) {
    let forms = drafts.get(scope);
    if (!forms) {
      forms = new Map();
      drafts.set(scope, forms);
    }
    forms.set(key, draft);
    notify(scope);
  },
  beginSubmit(scope: string, key: string, values: FormDraft['values']) {
    const current = this.get(scope, key);
    if (current && current.status !== 'editing') return null;
    const pending: FormDraft = { values, status: 'sending' };
    this.set(scope, key, pending);
    return pending;
  },
  finishSubmit(
    scope: string,
    key: string,
    pending: FormDraft,
    accepted: boolean,
  ) {
    // A late response must not resurrect a closed chat's draft.
    if (this.get(scope, key) !== pending) return;
    this.set(scope, key, {
      values: pending.values,
      status: accepted ? 'submitted' : 'unconfirmed',
      ...(accepted
        ? {}
        : {
            error:
              'Submission could not be confirmed. Your input has been kept; check the conversation’s send status before retrying.',
          }),
    });
  },
};
