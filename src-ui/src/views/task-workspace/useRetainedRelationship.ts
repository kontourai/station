import { MAX_TASK_TITLE_LENGTH } from '@kontourai/station-contracts/task-graph';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

const text = z.string().min(1).max(512);
const identity = z.object({ taskId: text, taskCreatedAt: text }).strict();
export const childIntent = z
  .object({
    operationId: text,
    parent: identity,
    task: z
      .object({
        projectId: text,
        title: z
          .string()
          .min(1)
          .max(MAX_TASK_TITLE_LENGTH)
          .refine((value) => value === value.trim()),
      })
      .strict(),
  })
  .strict();
export const chatIntent = z
  .object({
    operationId: text,
    task: identity,
    conversationId: text,
    expectedRevision: z.number().int().nonnegative().safe(),
    linked: z.boolean(),
  })
  .strict();

// One slot per panel retires intents when its Task or connection changes.
export function useRetainedRelationship<T>(
  kind: string,
  scopeKey: string,
  schema: z.ZodType<T>,
) {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const storageKey = `station-task-relationship:${kind}`;
  const [notice, setNotice] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [request, setRequest] = useState<T | undefined>(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return;
      const envelope = z
        .object({ scopeKey: z.string(), input: schema })
        .strict()
        .safeParse(JSON.parse(raw));
      if (envelope.success && envelope.data.scopeKey === scopeKey)
        return envelope.data.input;
      sessionStorage.removeItem(storageKey);
    } catch {
      // Admission below must successfully retain the complete intent before sending.
    }
  });
  function retain(input: T) {
    try {
      const validated = schema.parse(input);
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({ scopeKey, input: validated }),
      );
      setRequest(validated);
      setNotice('');
      return true;
    } catch {
      setNotice(
        'Could not save this change. Try again when browser storage is available.',
      );
      return false;
    }
  }
  function clear() {
    try {
      sessionStorage.removeItem(storageKey);
      setRequest(undefined);
      return true;
    } catch {
      setBlocked(true);
      setNotice('Could not clear this saved change. Reload before continuing.');
      return false;
    }
  }
  return {
    request,
    retain,
    clear,
    notice,
    blocked,
    isActive: () => active.current,
  };
}
