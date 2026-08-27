import {
  useFeaturePreviewsQuery,
  useUpdateFeaturePreviewMutation,
} from '@kontourai/station-sdk';
import { PageRow } from '../../components/PageRow';
import { Empty, ErrorState, SkeletonList } from '../../components/state';
import { Toggle } from '../../components/Toggle';
import { SettingsSection } from './SettingsSection';

/**
 * Feature previews as a Settings section (station#3313, IA option A) — the
 * content of the retired standalone /feature-previews view. Previews are
 * server-persisted toggles: a preview appears here only while this Station
 * build offers it, and enabling one is what unlocks any surface gated on its
 * preview flag (see useSurfaceVisibilityFlags).
 */
export function FeaturePreviewsSection() {
  const previews = useFeaturePreviewsQuery();
  const update = useUpdateFeaturePreviewMutation();

  return (
    <SettingsSection
      icon="⚗"
      title="Feature previews"
      id="section-feature-previews"
    >
      {/* The catalog-completeness gate keys off data-catalog-id; the rows
          themselves are per-preview and server-derived, so the one catalog
          entry sits on the section body in every state.

          `id`/`tabIndex` are what `PageRow` gives every other catalog entry,
          and `?highlight=` is a live pattern (CoreUpdateLaunchCheck,
          views/task-experiences.ts) that resolves through
          `document.getElementById(<catalog id>)` and silently does nothing
          when the element is absent — this was the only entry not going
          through `PageRow`, so its highlight link went nowhere. */}
      <div
        id="feature-previews"
        data-catalog-id="feature-previews"
        tabIndex={-1}
      >
        <p className="settings__field-hint">
          Try features that are still being evaluated.
        </p>
        {previews.isLoading ? (
          <SkeletonList
            count={4}
            withIcon={false}
            label="Loading feature previews"
          />
        ) : previews.error ? (
          <ErrorState
            title="Could not load feature previews"
            description="Station could not determine which previews this instance currently offers."
            action={
              <button type="button" onClick={() => previews.refetch()}>
                Retry
              </button>
            }
          />
        ) : (previews.data ?? []).length === 0 ? (
          <Empty
            variant="prominent"
            label="No previews are currently offered"
            description="Previews appear here only when this Station build can exercise them."
          />
        ) : (
          <>
            {(previews.data ?? []).map((preview) => (
              <PageRow
                key={preview.id}
                title={preview.label}
                description={preview.description}
                control={
                  <Toggle
                    checked={preview.enabled}
                    disabled={update.isPending}
                    label={`Enable ${preview.label}`}
                    onChange={(enabled) =>
                      update.mutate({ id: preview.id, enabled })
                    }
                  />
                }
              />
            ))}
            {update.error && <p role="alert">{update.error.message}</p>}
          </>
        )}
      </div>
    </SettingsSection>
  );
}
