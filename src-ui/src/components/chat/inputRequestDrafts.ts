import type { InputRequestForm } from '@kontourai/station-contracts/input-request';
import { createStore, del, get, keys, set } from 'idb-keyval';

/**
 * #3390: what the person has typed or chosen in an open form, before it is
 * read as content. A choice field's custom answer is its own text, keyed by
 * field name; `values` then holds the "own answer" choice.
 */
export interface InputRequestDraft {
  values: Record<string, string | boolean | string[] | undefined>;
  custom: Record<string, string>;
}

// The pre-#3390 harness question drafts lived in this same store. An entry
// in that shape admits nothing below and is simply not restored.
const store = createStore('station-harness-question-drafts', 'answers');
const MAX_DRAFTS = 32;
const MAX_TEXT = 12000;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Keep only what this form could have produced, and never a secret field:
 * a draft is device storage, read back without the person in the loop.
 */
function admitted(form: InputRequestForm, value: unknown): InputRequestDraft {
  const draft: InputRequestDraft = { values: {}, custom: {} };
  if (!record(value) || !record(value.values)) return draft;
  const custom = record(value.custom) ? value.custom : {};
  for (const field of form.body.fields) {
    if ('secret' in field && field.secret) continue;
    const item = value.values[field.name];
    const choices =
      'options' in field
        ? new Set([
            ...field.options.map((option) => option.value),
            ...(field.allowCustom ? ['\u0000custom'] : []),
          ])
        : undefined;
    switch (field.kind) {
      case 'boolean':
        if (typeof item === 'boolean') draft.values[field.name] = item;
        break;
      case 'choice':
        if (typeof item === 'string' && choices?.has(item))
          draft.values[field.name] = item;
        break;
      case 'multi-choice':
        if (Array.isArray(item))
          draft.values[field.name] = [
            ...new Set(
              item.filter(
                (entry): entry is string =>
                  typeof entry === 'string' && !!choices?.has(entry),
              ),
            ),
          ];
        break;
      default:
        if (typeof item === 'string')
          draft.values[field.name] = item.slice(0, MAX_TEXT);
    }
    const text = custom[field.name];
    if ('allowCustom' in field && field.allowCustom && typeof text === 'string')
      draft.custom[field.name] = text.slice(0, MAX_TEXT);
  }
  return draft;
}

export async function readInputRequestDraft(
  key: string,
  form: InputRequestForm,
): Promise<InputRequestDraft | undefined> {
  try {
    const stored = await get<{ draft?: unknown }>(key, store);
    return stored?.draft === undefined
      ? undefined
      : admitted(form, stored.draft);
  } catch {
    return undefined;
  }
}

export async function saveInputRequestDraft(
  key: string,
  form: InputRequestForm,
  draft: InputRequestDraft,
): Promise<boolean> {
  try {
    await set(
      key,
      { draft: admitted(form, draft), updatedAt: Date.now() },
      store,
    );
    const all = await keys<string>(store);
    if (all.length > MAX_DRAFTS) {
      const records = await Promise.all(
        all.map(async (entry) => ({
          key: entry,
          value: await get<{ updatedAt?: number }>(entry, store),
        })),
      );
      for (const old of records
        .sort((a, b) => (b.value?.updatedAt ?? 0) - (a.value?.updatedAt ?? 0))
        .slice(MAX_DRAFTS))
        await del(old.key, store);
    }
    return true;
  } catch {
    return false;
  }
}

export async function clearInputRequestDraft(key: string): Promise<void> {
  try {
    await del(key, store);
  } catch {
    /* Keep the current answers usable when device storage is unavailable. */
  }
}
