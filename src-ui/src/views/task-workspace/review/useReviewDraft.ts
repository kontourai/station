import { useEffect, useState } from 'react';

function readDraft(key: string) {
  try {
    return sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function useReviewDraft(key: string) {
  const storageKey = `station:review-draft:${key}`;
  const [state, setState] = useState(() => ({
    key: storageKey,
    body: readDraft(storageKey),
  }));
  const body = state.key === storageKey ? state.body : readDraft(storageKey);
  const [savedBody, setSavedBody] = useState<string>();
  useEffect(() => {
    try {
      if (body) sessionStorage.setItem(storageKey, body);
      else sessionStorage.removeItem(storageKey);
      setSavedBody(body);
    } catch {
      setSavedBody(undefined);
    }
  }, [body, storageKey]);
  return {
    body,
    setBody: (body: string) => setState({ key: storageKey, body }),
    saved: Boolean(body) && savedBody === body,
  };
}
