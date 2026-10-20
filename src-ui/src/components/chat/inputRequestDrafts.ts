import type { InputRequestForm } from '@kontourai/station-contracts/input-request';
import { ownArray, ownRecord } from '@kontourai/station-shared/input-request';
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

/**
 * Field-keyed maps have no prototype, so a field named `constructor` or
 * `toString` reads as itself and never as an inherited property. Every
 * update builds a fresh one.
 */
export function fieldMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function withField<T>(
  map: Record<string, T>,
  name: string,
  value: T,
): Record<string, T> {
  const next = Object.assign(fieldMap<T>(), map);
  next[name] = value;
  return next;
}

export function withoutField<T>(
  map: Record<string, T>,
  name: string,
): Record<string, T> {
  const next = Object.assign(fieldMap<T>(), map);
  delete next[name];
  return next;
}

/** The draft value that stands for "my own answer" in a choice field. */
export const CUSTOM_CHOICE = '\u0000custom';

// The pre-#3390 harness question drafts lived in this same store. An entry
// in that shape admits nothing below and is simply not restored.
const store = createStore('station-harness-question-drafts', 'answers');
const MAX_DRAFTS = 32;
const MAX_TEXT = 12000;

/**
 * Keep only what this form could have produced, and never a secret field:
 * a draft is device storage, read back without the person in the loop.
 */
function admitted(form: InputRequestForm, value: unknown): InputRequestDraft {
  const draft: InputRequestDraft = { values: fieldMap(), custom: fieldMap() };
  // Device storage is read like any untrusted input: by its own keys only.
  const stored = ownRecord(value);
  const values = ownRecord(stored?.values);
  if (!values) return draft;
  const custom = ownRecord(stored?.custom) ?? fieldMap<unknown>();
  for (const field of form.body.fields) {
    if (
      (field.kind === 'string' ||
        field.kind === 'choice' ||
        field.kind === 'multi-choice') &&
      field.secret
    )
      continue;
    const item = values[field.name];
    const choices =
      field.kind === 'choice' || field.kind === 'multi-choice'
        ? new Set([
            ...field.options.map((option) => option.value),
            ...(field.allowCustom ? [CUSTOM_CHOICE] : []),
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
      case 'multi-choice': {
        const items = ownArray(item);
        if (items)
          draft.values[field.name] = [
            ...new Set(
              items.filter(
                (entry): entry is string =>
                  typeof entry === 'string' && !!choices?.has(entry),
              ),
            ),
          ];
        break;
      }
      default:
        if (typeof item === 'string')
          draft.values[field.name] = item.slice(0, MAX_TEXT);
    }
    const text = custom[field.name];
    if (
      (field.kind === 'choice' || field.kind === 'multi-choice') &&
      field.allowCustom &&
      typeof text === 'string'
    )
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
