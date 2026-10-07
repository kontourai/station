import { activeChatsStore } from './active-chats-store';

interface FormDraft {
  values: Record<string, string | boolean>;
  status: 'editing' | 'sending' | 'submitted' | 'unconfirmed';
  error?: string;
  submissionToken?: object;
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
    const pending: FormDraft = {
      values,
      status: 'sending',
      submissionToken: {},
    };
    this.set(scope, key, pending);
    return pending;
  },
  claimRetry(scope: string, key: string, pending: FormDraft) {
    const current = this.get(scope, key);
    if (
      !current ||
      current.submissionToken !== pending.submissionToken ||
      current.status === 'sending' ||
      current.status === 'submitted'
    )
      return false;
    this.set(scope, key, pending);
    return true;
  },
  finishSubmit(
    scope: string,
    key: string,
    pending: FormDraft,
    admission: 'accepted' | 'not-invoked' | 'indeterminate',
  ) {
    // Late acknowledgements, including Retry, belong only to this submission.
    if (this.get(scope, key)?.submissionToken !== pending.submissionToken)
      return;
    this.set(scope, key, {
      ...pending,
      status:
        admission === 'accepted'
          ? 'submitted'
          : admission === 'not-invoked'
            ? 'editing'
            : 'unconfirmed',
      ...(admission === 'accepted'
        ? {}
        : {
            error:
              admission === 'not-invoked'
                ? 'The form was not sent. Your input has been kept.'
                : 'Submission could not be confirmed. Your input has been kept; check the conversation’s send status before retrying.',
          }),
    });
  },
};
