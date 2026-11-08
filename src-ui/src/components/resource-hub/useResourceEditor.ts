import { useCallback, useEffect, useRef, useState } from 'react';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';

interface ResourceEditorOptions<T> {
  /** The server copy; `null`/`undefined` while nothing is selected or read. */
  source: T | null | undefined;
  /** Which resource `source` is. A new identity always re-seeds. */
  identity: (source: T) => string;
  /** A draft the edits may mutate without touching the server copy. */
  clone: (source: T) => T;
  /**
   * True while a save is in flight. Discard is refused then: the save could
   * still land after the navigation and pull the reader back to this record.
   */
  isSaving?: () => boolean;
}

/**
 * One editable copy of a server resource: seeded from `source`, marked dirty
 * by `update`, registered with `useUnsavedGuard`, and cleaned by `saved` or
 * `reset`.
 *
 * Seeding: selecting a different resource always re-seeds, even mid-edit; a
 * refetch of the same one replaces the draft only while it is clean. The
 * server copy is not merged into unsaved edits: reconciling a stale edit
 * against a changed record is a conflict, and picking a winner per field
 * makes a form that is neither.
 */
export function useResourceEditor<T>({
  source,
  identity,
  clone,
  isSaving,
}: ResourceEditorOptions<T>) {
  const [draft, setDraft] = useState<T | null>(() =>
    source ? clone(source) : null,
  );
  const [dirty, setDirty] = useState(false);
  const seededId = useRef<string | null>(source ? identity(source) : null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const helpers = useRef({ identity, clone, isSaving });
  helpers.current = { identity, clone, isSaving };
  // Discard means discard: the draft returns to the server copy, so the
  // navigation that asked continues from a clean editor.
  const discard = useRef(() => true);
  const { guard, DiscardModal } = useUnsavedGuard(dirty, () =>
    discard.current(),
  );

  useEffect(() => {
    if (!source) {
      seededId.current = null;
      setDraft(null);
      setDirty(false);
      return;
    }
    const id = helpers.current.identity(source);
    if (id === seededId.current && dirtyRef.current) return;
    seededId.current = id;
    setDraft(helpers.current.clone(source));
    setDirty(false);
  }, [source]);

  const update = useCallback((change: (current: T) => T) => {
    setDirty(true);
    setDraft((current) => (current ? change(current) : current));
  }, []);

  /** The server accepted the draft: it is the clean copy now. */
  const saved = useCallback((result: T) => {
    seededId.current = helpers.current.identity(result);
    setDraft(helpers.current.clone(result));
    setDirty(false);
  }, []);

  const reset = useCallback(() => {
    setDraft(source ? helpers.current.clone(source) : null);
    setDirty(false);
  }, [source]);
  discard.current = () => {
    if (helpers.current.isSaving?.()) return false;
    reset();
    return true;
  };

  return {
    draft,
    dirty,
    update,
    saved,
    reset,
    /**
     * Ask before a local action that would discard unsaved edits. Route
     * changes ask by themselves; a route tab inside the same record does not
     * (`isSameRecordTabTraversal`).
     */
    guard,
    DiscardModal,
  };
}
