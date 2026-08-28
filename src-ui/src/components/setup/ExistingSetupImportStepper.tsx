/**
 * The one existing-setup import workflow used wherever Station offers it.
 * It only receives content-free SDK projections: source-relative names and
 * digests are useful to review, while prompt text and host paths never enter
 * this component or the browser bundle.
 */

import type { ExistingSetupImportReceipt } from '@kontourai/station-sdk/setup-imports';
import type { SetupImportTargetReview } from '@kontourai/station-sdk/setup-imports-query';
import {
  useApplySetupImportMutation,
  useCreateSetupImportPreviewMutation,
  useReviewSetupImportTargetsMutation,
  useRollbackSetupImportMutation,
  useSetupImportSourcesQuery,
} from '@kontourai/station-sdk/setup-imports-query';
import { SETUP_IMPORT_MAX_TARGET_NAME_LENGTH } from '@kontourai/station-shared/setup-import-bounds';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../Button';
import { Checkbox } from '../Checkbox';
import { ResponsiveSurfaceActions } from '../ResponsiveDialogSurface';
import { SkeletonBlock } from '../state';
import './ExistingSetupImportStepper.css';

const INVALID_SKILL_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/** Mirrors Station's public skill-name rule before the server validates it. */
function isStationSkillName(name: string): boolean {
  return (
    name.trim() !== '' &&
    name.length <= SETUP_IMPORT_MAX_TARGET_NAME_LENGTH &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    name !== '.' &&
    !INVALID_SKILL_NAMES.has(name)
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

export interface ExistingSetupImportStepperProps {
/** A capability ID, not an engine or connection identity. */
  sourceId?: string;
  compact?: boolean;
}

export function ExistingSetupImportStepper({
  sourceId = 'codex-prompts',
  compact = false,
}: ExistingSetupImportStepperProps) {
  const sources = useSetupImportSourcesQuery();
  const previewMutation = useCreateSetupImportPreviewMutation();
  const applyMutation = useApplySetupImportMutation();
  const reviewMutation = useReviewSetupImportTargetsMutation();
  const rollbackMutation = useRollbackSetupImportMutation();
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [receipt, setReceipt] = useState<ExistingSetupImportReceipt>();
  const [boundTargets, setBoundTargets] = useState<SetupImportTargetReview>();
  const source = sources.data?.find((candidate) => candidate.id === sourceId);
  const preview = previewMutation.data;
  const targetReview = boundTargets ?? reviewMutation.data;

  useEffect(() => {
    if (!preview) return;
    setSelected(
      Object.fromEntries(
        preview.entries.map((entry) => [entry.id, !entry.collision]),
      ),
    );
    setTargets(
      Object.fromEntries(
        preview.entries
          .filter((entry) => !entry.collision)
          .map((entry) => [entry.id, entry.skillName]),
      ),
    );
    setReceipt(undefined);
    setBoundTargets(undefined);
    reviewMutation.reset();
  }, [preview, reviewMutation.reset]);

  const selectedCollisionInvalid = useMemo(
    () =>
      preview?.entries.some(
        (entry) =>
          entry.collision &&
          selected[entry.id] &&
          !isStationSkillName(targets[entry.id] ?? ''),
      ) ?? false,
    [preview, selected, targets],
  );
  const excludedCount = preview
    ? Object.values(preview.excluded).reduce((total, count) => total + count, 0)
    : 0;
  const summary = receipt
    ? receipt.items.reduce(
        (counts, item) => {
          counts[item.outcome] += 1;
          return counts;
        },
        {
          imported: 0,
          skipped: 0,
          failed: 0,
          'rolled-back': 0,
          indeterminate: 0,
        },
      )
    : undefined;
  const resetWorkflow = () => {
    previewMutation.reset();
    applyMutation.reset();
    reviewMutation.reset();
    rollbackMutation.reset();
    setSelected({});
    setTargets({});
    setReceipt(undefined);
    setBoundTargets(undefined);
  };

  if (sources.isLoading) {
    return (
      <SkeletonBlock count={compact ? 1 : 2} label="Checking existing setup" />
    );
  }
  if (sources.isError || !source?.available) return null;

  return (
    <section
      className={`existing-setup-import${compact ? ' existing-setup-import--compact' : ''}`}
      aria-labelledby={`existing-setup-import-${sourceId}`}
      data-testid="existing-setup-import-stepper"
    >
      <div className="existing-setup-import__heading">
        <div>
          <h3 id={`existing-setup-import-${sourceId}`}>
            Bring in existing setup
          </h3>
          <p>
            Review immediate prompt files as Skills. Station never displays
            their contents or a filesystem location here.
          </p>
        </div>
        {!preview && !receipt && (
          <Button
            variant="secondary"
            pending={previewMutation.isPending}
            pendingLabel="Preparing preview…"
            onClick={() => previewMutation.mutate(sourceId)}
          >
            Review import
          </Button>
        )}
      </div>

      <p className="existing-setup-import__status" role="status">
        {previewMutation.isError
          ? previewMutation.error.message
          : applyMutation.isPending
            ? 'Importing reviewed items…'
            : rollbackMutation.isPending
              ? 'Rolling back receipt…'
              : ''}
      </p>

      {preview && !receipt && (
        <div className="existing-setup-import__preview">
          <p className="existing-setup-import__summary">
            {preview.entries.length} eligible item
            {preview.entries.length === 1 ? '' : 's'}
            {excludedCount > 0 ? ` · ${excludedCount} excluded` : ''}
          </p>
          {excludedCount > 0 && (
            <p className="existing-setup-import__exclusions">
              Excluded:{' '}
              {Object.entries(preview.excluded)
                .map(([reason, count]) => `${count} ${reason}`)
                .join(', ')}
              .
            </p>
          )}
          {preview.warnings.length > 0 && (
            <p className="existing-setup-import__warnings">
              Warnings: {preview.warnings.join(', ')}.
            </p>
          )}
          <ul className="existing-setup-import__entries">
            {preview.entries.map((entry) => {
              const checked = selected[entry.id] ?? false;
              const target = targets[entry.id] ?? '';
              const renameInvalid =
                entry.collision && checked && !isStationSkillName(target);
              return (
                <li key={entry.id} className="existing-setup-import__entry">
                  <Checkbox
                    checked={checked}
                    onChange={(next) => {
                      reviewMutation.reset();
                      setSelected((current) => ({
                        ...current,
                        [entry.id]: next,
                      }));
                    }}
                    id={`setup-import-${entry.id}`}
                  >
                    <span className="existing-setup-import__identity">
                      {entry.name}
                    </span>
                  </Checkbox>
                  <dl className="existing-setup-import__facts">
                    <div>
                      <dt>Proposed target</dt>
                      <dd>
                        {entry.collision
                          ? target || 'Choose a new name'
                          : entry.skillName}
                      </dd>
                    </div>
                    <div>
                      <dt>Size</dt>
                      <dd>{formatBytes(entry.size)}</dd>
                    </div>
                    <div>
                      <dt>Digest</dt>
                      <dd>
                        <code>{entry.digest}</code>
                      </dd>
                    </div>
                  </dl>
                  {entry.collision && (
                    <label className="existing-setup-import__rename">
                      New Station Skill name
                      <input
                        className="editor-input"
                        aria-label={`New Station Skill name for ${entry.name}`}
                        value={target}
                        disabled={!checked}
                        aria-invalid={renameInvalid || undefined}
                        aria-describedby={
                          renameInvalid
                            ? `setup-import-name-error-${entry.id}`
                            : undefined
                        }
                        onChange={(event) => {
                          reviewMutation.reset();
                          setTargets((current) => ({
                            ...current,
                            [entry.id]: event.target.value,
                          }));
                        }}
                      />
                      {renameInvalid && (
                        <span
                          id={`setup-import-name-error-${entry.id}`}
                          className="existing-setup-import__error"
                        >
                          Choose a single Station Skill name, or uncheck to skip
                          this collision.
                        </span>
                      )}
                    </label>
                  )}
                  {entry.warnings && entry.warnings.length > 0 && (
                    <p className="existing-setup-import__warnings">
                      Warnings: {entry.warnings.join(', ')}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          <ResponsiveSurfaceActions className="existing-setup-import__actions">
            <Button
              variant="primary"
              pending={reviewMutation.isPending}
              pendingLabel="Binding targets…"
              disabled={selectedCollisionInvalid}
              onClick={() =>
                reviewMutation.mutate(
                  {
                    previewId: preview.id,
                    items: preview.entries.map((entry) => ({
                      id: entry.id,
                      action: selected[entry.id] ? 'import' : 'skip',
                      ...(selected[entry.id]
                        ? { targetName: targets[entry.id] ?? entry.skillName }
                        : {}),
                    })),
                  },
                  { onSuccess: setBoundTargets },
                )
              }
            >
              Review targets
            </Button>
            <Button variant="ghost" onClick={resetWorkflow}>
              Start over
            </Button>
          </ResponsiveSurfaceActions>
          {reviewMutation.isError && (
            <p className="existing-setup-import__error" role="alert">
              {reviewMutation.error.message}
            </p>
          )}
          {targetReview && (
            <ResponsiveSurfaceActions className="existing-setup-import__actions">
              <p>
                Targets bound until {targetReview.witness.expiresAt}:{' '}
                {targetReview.witness.items
                  .filter((item) => item.action === 'import')
                  .map((item) => item.targetName)
                  .join(', ') || 'no imports'}
                .
              </p>
              <Button
                variant="primary"
                pending={applyMutation.isPending}
                pendingLabel="Importing…"
                onClick={() =>
                  applyMutation.mutate(
                    {
                      previewId: preview.id,
                      witnessId: targetReview.witness.id,
                    },
                    { onSuccess: setReceipt },
                  )
                }
              >
                Apply reviewed targets
              </Button>
            </ResponsiveSurfaceActions>
          )}
        </div>
      )}

      {receipt && (
        <div
          className="existing-setup-import__receipt"
          tabIndex={-1}
          aria-live="polite"
        >
          <h4>
            {receipt.rolledBackAt ? 'Rollback receipt' : 'Import receipt'}
          </h4>
          <div className="import-modal__preview-list existing-setup-import__outcomes">
            {receipt.items.map((item) => (
              <div key={item.sourceId} className="import-modal__preview-item">
                <span className="import-modal__file-label">
                  {item.sourceId} — {item.outcome} ({item.state})
                  {item.reviewedTarget ? ` as ${item.reviewedTarget}` : ''}
                  {item.targetRevision
                    ? ` · revision ${item.targetRevision}`
                    : ''}
                  {` · rollback ${item.rollback.state}`}
                  {item.reasonCode ? ` · ${item.reasonCode}` : ''}
                  {item.repairCode ? ` · repair: ${item.repairCode}` : ''}
                </span>
              </div>
            ))}
          </div>
          <p className="existing-setup-import__summary">
            {summary &&
              `Imported ${summary.imported}; skipped ${summary.skipped}; failed ${summary.failed}; rolled back ${summary['rolled-back']}; indeterminate ${summary.indeterminate}.`}
          </p>
          {receipt.retryable && (
            <ResponsiveSurfaceActions className="existing-setup-import__actions">
              <Button
                variant="secondary"
                pending={rollbackMutation.isPending}
                pendingLabel="Rolling back…"
                onClick={() =>
                  rollbackMutation.mutate(receipt.id, { onSuccess: setReceipt })
                }
              >
                Roll back imported items
              </Button>
            </ResponsiveSurfaceActions>
          )}
          <ResponsiveSurfaceActions className="existing-setup-import__actions">
            <Button variant="ghost" onClick={resetWorkflow}>
              Import another preview
            </Button>
          </ResponsiveSurfaceActions>
          {rollbackMutation.isError && (
            <p className="existing-setup-import__error" role="alert">
              {rollbackMutation.error.message} Check this receipt before
              retrying a rollback.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
