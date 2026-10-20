/**
 * Root picker: the person's manual choice between personal and project roots.
 * Consumes the K4 `useKnowledgeRootsQuery` hook (`@kontourai/station-sdk`)
 * rather than forking a fetch of `/api/knowledge/roots`, and never selects a
 * root on the person's behalf.
 *
 * The relevant-root filter lives in `./roots.ts`, shared with `AskPane.tsx`.
 */
import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { useKnowledgeRootsQuery, useNavigation } from '@kontourai/station-sdk';
import { isRelevantRoot } from './roots';
import { Empty, ErrorState, Skeleton } from './state';

export interface RootPickerProps {
  value: string | null;
  onChange: (rootId: string, root: KnowledgeStoreRoot) => void;
}

export function RootPicker({ value, onChange }: RootPickerProps) {
  const navigation = useNavigation();
  const selectedProject = navigation.selectedProject ?? null;
  const rootsQuery = useKnowledgeRootsQuery();

  if (rootsQuery.isLoading) {
    return (
      <div className="mn-root-picker" data-testid="mn-root-picker-loading">
        <Skeleton variant="line" className="mn-root-picker__skeleton" />
      </div>
    );
  }

  if (rootsQuery.isError) {
    return (
      <ErrorState
        title="Could not load knowledge roots"
        description={
          rootsQuery.error instanceof Error
            ? rootsQuery.error.message
            : String(rootsQuery.error)
        }
      />
    );
  }

  const roots = (rootsQuery.data ?? []).filter((root) =>
    isRelevantRoot(root, selectedProject),
  );

  if (roots.length === 0) {
    return (
      <Empty
        variant="compact"
        label="No personal or project knowledge root registered yet"
        description="Register a personal or project knowledge-store root in Settings before capturing a meeting."
      />
    );
  }

  return (
    <label className="mn-field" htmlFor="mn-root-select">
      <span className="mn-field__label">Knowledge root</span>
      <select
        id="mn-root-select"
        data-testid="mn-root-select"
        className="mn-select"
        value={value ?? ''}
        onChange={(event) => {
          const root = roots.find(
            (candidate) => candidate.id === event.target.value,
          );
          if (root) onChange(root.id, root);
        }}
      >
        <option value="" disabled>
          — select a personal or project root —
        </option>
        {roots.map((root) => (
          <option key={root.id} value={root.id}>
            {root.displayName} (
            {root.scope.kind === 'personal' ? 'personal' : 'project'})
          </option>
        ))}
      </select>
    </label>
  );
}
