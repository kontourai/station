import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { isRelevantKnowledgeRoot } from '@kontourai/station-sdk';
import { Empty, ErrorState, Skeleton } from './state';

export const isRelevantRoot = isRelevantKnowledgeRoot;

export interface RootPickerProps {
  roots: KnowledgeStoreRoot[];
  isLoading: boolean;
  error: unknown;
  value: string | null;
  onChange: (root: KnowledgeStoreRoot) => void;
  onRetry: () => void;
  onOpenSettings?: () => void;
}

export function RootPicker({
  roots,
  isLoading,
  error,
  value,
  onChange,
  onRetry,
  onOpenSettings,
}: RootPickerProps) {
  if (isLoading) {
    return (
      <div className="kl-root-picker" data-testid="kl-root-picker-loading">
        <Skeleton variant="line" />
      </div>
    );
  }

  if (error) {
    return (
      <ErrorState
        title="Could not load knowledge roots"
        description={error instanceof Error ? error.message : String(error)}
        action={
          <button type="button" className="kl-button" onClick={onRetry}>
            Try again
          </button>
        }
      />
    );
  }

  if (roots.length === 0) {
    return (
      <Empty
        variant="compact"
        label="No relevant Knowledge Kit root"
        description="Register a personal root or a root for this project before opening the library."
        action={
          onOpenSettings ? (
            <button
              type="button"
              className="kl-button"
              onClick={onOpenSettings}
            >
              Open knowledge settings
            </button>
          ) : undefined
        }
      />
    );
  }

  return (
    <label className="kl-field" htmlFor="kl-root-select">
      <span className="kl-field__label">Knowledge root</span>
      <select
        id="kl-root-select"
        data-testid="kl-root-select"
        className="kl-select"
        value={value ?? ''}
        onChange={(event) => {
          const root = roots.find(
            (candidate) => candidate.id === event.target.value,
          );
          if (root) onChange(root);
        }}
      >
        <option value="" disabled>
          — select a personal or project root —
        </option>
        {roots.map((root) => (
          <option key={root.id} value={root.id}>
            {root.displayName} ({root.scope.kind})
          </option>
        ))}
      </select>
    </label>
  );
}
