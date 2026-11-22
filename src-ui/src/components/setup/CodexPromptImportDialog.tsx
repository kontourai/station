/**
 * Import Codex's saved prompts as Station skills, and undo the whole import.
 *
 * It only receives content-free SDK projections: source file names and skill
 * names are shown, while prompt text and host paths never enter this
 * component or the browser bundle.
 *
 * The server binds an import in two steps (bind the reviewed names, then
 * apply that exact binding). The dialog makes them one action: the person's
 * review is the list they ticked, and "Import" sends both steps back to back.
 */

import type {
  ExistingSetupImportOutcome,
  ExistingSetupImportReceipt,
} from '@kontourai/station-sdk/setup-imports';
import {
  useApplySetupImportMutation,
  useCreateSetupImportPreviewMutation,
  useReviewSetupImportTargetsMutation,
  useRollbackSetupImportMutation,
} from '@kontourai/station-sdk/setup-imports-query';
import { SETUP_IMPORT_MAX_TARGET_NAME_LENGTH } from '@kontourai/station-shared/setup-import-bounds';
import { Badge } from '@kontourai/ui/react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { userFacingErrorMessage } from '../../utils/errorText';
import { Button } from '../Button';
import { Checkbox } from '../Checkbox';
import { Dialog } from '../Dialog';
import { Empty, ErrorState, SkeletonBlock } from '../state';
import './CodexPromptImportDialog.css';

const SOURCE_ID = 'codex-prompts';
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

function skillCount(count: number): string {
  return `${count} skill${count === 1 ? '' : 's'}`;
}

/** Why an item did not land, in the person's words. */
function notImportedReason(item: ExistingSetupImportOutcome): string {
  switch (item.reasonCode) {
    case 'target-not-absent':
    case 'target-conflict':
      return 'A skill with this name already exists.';
    case 'source-changed':
    case 'source-namespace-changed':
    case 'source-invalid':
      return 'The Codex prompt changed. Close and import again.';
    default:
      return 'Could not import this prompt.';
  }
}

interface CodexPromptImportDialogProps {
  open: boolean;
  onClose: () => void;
}

export function CodexPromptImportDialog({
  open,
  onClose,
}: CodexPromptImportDialogProps) {
  if (!open) return null;
  // Portalled for the same reason as the Skills page's other import dialog:
  // its trigger lives in the list pane, which a phone marks inert while a
  // skill sheet is open.
  return createPortal(
    <CodexPromptImportBody onClose={onClose} />,
    document.body,
  );
}

function CodexPromptImportBody({ onClose }: { onClose: () => void }) {
  const previewMutation = useCreateSetupImportPreviewMutation();
  const reviewMutation = useReviewSetupImportTargetsMutation();
  const applyMutation = useApplySetupImportMutation();
  const rollbackMutation = useRollbackSetupImportMutation();
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [receipt, setReceipt] = useState<ExistingSetupImportReceipt>();
  const preview = previewMutation.data;
  const createPreview = previewMutation.mutate;

  // A fresh look at the prompts folder each time the dialog opens.
  useEffect(() => {
    createPreview(SOURCE_ID);
  }, [createPreview]);

  // Nothing is pre-selected. A name conflict starts with a suggested new
  // name, so ticking the row is enough to import it under that name.
  useEffect(() => {
    if (!preview) return;
    setSelected({});
    setTargets(
      Object.fromEntries(
        preview.entries.map((entry) => [
          entry.id,
          entry.collision ? `${entry.skillName}-codex` : entry.skillName,
        ]),
      ),
    );
    setReceipt(undefined);
  }, [preview]);

  const entries = preview?.entries ?? [];
  const chosen = entries.filter((entry) => selected[entry.id]);
  const chosenNames = chosen.map((entry) => targets[entry.id] ?? '');
  const duplicateName = (name: string) =>
    chosenNames.filter((candidate) => candidate === name).length > 1;
  const invalidChoice = chosen.some((entry) => {
    const name = targets[entry.id] ?? '';
    return !isStationSkillName(name) || duplicateName(name);
  });
  const importing = reviewMutation.isPending || applyMutation.isPending;
  const allSelected = entries.length > 0 && chosen.length === entries.length;
  const excludedCount = preview
    ? Object.values(preview.excluded).reduce((total, count) => total + count, 0)
    : 0;

  const startImport = () => {
    if (!preview || chosen.length === 0 || invalidChoice) return;
    reviewMutation.mutate(
      {
        previewId: preview.id,
        items: entries.map((entry) =>
          selected[entry.id]
            ? {
                id: entry.id,
                action: 'import' as const,
                targetName: targets[entry.id] ?? entry.skillName,
              }
            : { id: entry.id, action: 'skip' as const },
        ),
      },
      {
        onSuccess: (review) =>
          applyMutation.mutate(
            { previewId: preview.id, witnessId: review.witness.id },
            { onSuccess: setReceipt },
          ),
      },
    );
  };

  const title = 'Import your Codex prompts as skills';
  const closeLabel = 'Close Codex import';

  if (receipt) {
    return (
      <ImportResult
        title={title}
        closeLabel={closeLabel}
        receipt={receipt}
        undoPending={rollbackMutation.isPending}
        undoError={
          rollbackMutation.isError
            ? userFacingErrorMessage(rollbackMutation.error)
            : undefined
        }
        onUndo={() =>
          rollbackMutation.mutate(receipt.id, { onSuccess: setReceipt })
        }
        onClose={onClose}
      />
    );
  }

  return (
    <Dialog
      title={title}
      subtitle={
        preview && entries.length > 0
          ? `Station found ${entries.length} saved prompt${entries.length === 1 ? '' : 's'} in Codex. Pick the ones you want.`
          : undefined
      }
      closeLabel={closeLabel}
      onClose={onClose}
      size="lg"
      panelClassName="codex-import"
      footer={
        <>
          <p className="codex-import__footnote">
            Only Codex prompts can be imported today.
          </p>
          <Button variant="secondary" onClick={onClose} disabled={importing}>
            {entries.length > 0 ? 'Cancel' : 'Close'}
          </Button>
          {entries.length > 0 && (
            <Button
              variant="primary"
              pending={importing}
              pendingLabel="Importing…"
              disabled={chosen.length === 0 || invalidChoice}
              onClick={startImport}
            >
              Import {skillCount(chosen.length)}
            </Button>
          )}
        </>
      }
    >
      {previewMutation.isPending || (!preview && !previewMutation.isError) ? (
        <SkeletonBlock count={3} label="Looking for Codex prompts" />
      ) : previewMutation.isError ? (
        <ErrorState
          variant="compact"
          title="Could not read your Codex prompts"
          description={userFacingErrorMessage(previewMutation.error)}
          action={
            <Button
              variant="secondary"
              onClick={() => createPreview(SOURCE_ID)}
            >
              Try again
            </Button>
          }
        />
      ) : entries.length === 0 ? (
        <Empty label="Codex has no saved prompts Station can import." />
      ) : (
        <div className="codex-import__picker">
          <div className="codex-import__count-row">
            <span>
              {chosen.length} of {entries.length} selected
            </span>
            <button
              type="button"
              className="codex-import__select-all"
              disabled={importing}
              onClick={() =>
                setSelected(
                  allSelected
                    ? {}
                    : Object.fromEntries(
                        entries.map((entry) => [entry.id, true]),
                      ),
                )
              }
            >
              {allSelected ? 'Clear selection' : 'Select all'}
            </button>
          </div>
          <ul className="codex-import__rows">
            {entries.map((entry) => {
              const checked = selected[entry.id] ?? false;
              const target = targets[entry.id] ?? '';
              const nameProblem = !checked
                ? undefined
                : target.trim() === ''
                  ? 'Type a name, or untick to skip this prompt.'
                  : !isStationSkillName(target)
                    ? 'Choose a name without slashes or "..".'
                    : duplicateName(target)
                      ? 'Another selected prompt uses this name.'
                      : undefined;
              const messageId = `codex-import-message-${entry.id}`;
              return (
                <li key={entry.id} className="codex-import__row">
                  <div className="codex-import__head">
                    <Checkbox
                      id={`codex-import-${entry.id}`}
                      checked={checked}
                      disabled={importing}
                      onChange={(next) =>
                        setSelected((current) => ({
                          ...current,
                          [entry.id]: next,
                        }))
                      }
                    >
                      <span className="codex-import__name">
                        {entry.skillName}
                      </span>
                    </Checkbox>
                    <Badge
                      value={entry.collision ? 'Needs a name' : 'New skill'}
                      tone={entry.collision ? 'caution' : 'neutral'}
                    />
                  </div>
                  <p className="codex-import__detail">From {entry.name}</p>
                  {entry.collision && (
                    <div className="codex-import__conflict">
                      <p id={messageId} className="codex-import__conflict-text">
                        You already have a skill called “{entry.skillName}”.
                        Choose a new name to import it.
                      </p>
                      <input
                        className="editor-input codex-import__rename"
                        aria-label={`New name for ${entry.skillName}`}
                        aria-describedby={messageId}
                        aria-invalid={nameProblem ? true : undefined}
                        value={target}
                        disabled={importing}
                        onChange={(event) => {
                          const value = event.target.value;
                          setTargets((current) => ({
                            ...current,
                            [entry.id]: value,
                          }));
                          // Typing a name is choosing to import the prompt.
                          setSelected((current) => ({
                            ...current,
                            [entry.id]: true,
                          }));
                        }}
                      />
                    </div>
                  )}
                  {nameProblem && (
                    <p className="codex-import__error">{nameProblem}</p>
                  )}
                </li>
              );
            })}
          </ul>
          {excludedCount > 0 && (
            <p className="codex-import__note">
              {excludedCount} other file{excludedCount === 1 ? '' : 's'} in the
              Codex prompts folder can’t be imported.
            </p>
          )}
          <p className="codex-import__note">
            Station copies each prompt into a new skill and leaves your Codex
            files unchanged. You can undo the whole import when it finishes.
          </p>
          {(reviewMutation.isError || applyMutation.isError) && (
            <ErrorState
              variant="compact"
              title="Import did not finish"
              description={`${userFacingErrorMessage(
                reviewMutation.error ?? applyMutation.error,
              )} Check Skills before importing again.`}
            />
          )}
        </div>
      )}
    </Dialog>
  );
}

interface ImportResultProps {
  title: string;
  closeLabel: string;
  receipt: ExistingSetupImportReceipt;
  undoPending: boolean;
  undoError?: string;
  onUndo: () => void;
  onClose: () => void;
}

/** What happened, per prompt, read from the server's record of the import. */
function ImportResult({
  title,
  closeLabel,
  receipt,
  undoPending,
  undoError,
  onUndo,
  onClose,
}: ImportResultProps) {
  const attempted = receipt.items.filter((item) => item.outcome !== 'skipped');
  const imported = attempted.filter((item) => item.outcome === 'imported');
  const removed = attempted.filter((item) => item.outcome === 'rolled-back');
  const undone = Boolean(receipt.rolledBackAt);
  const canUndo = !undone && receipt.retryable && imported.length > 0;
  const heading = undone
    ? `Import undone. ${skillCount(removed.length)} removed.`
    : removed.length > 0
      ? `Undo removed ${skillCount(removed.length)}. ${skillCount(imported.length)} could not be removed.`
      : `Imported ${skillCount(imported.length)}.`;

  return (
    <Dialog
      title={title}
      closeLabel={closeLabel}
      onClose={onClose}
      size="lg"
      panelClassName="codex-import"
      footer={
        <>
          {canUndo && (
            <Button
              variant="secondary"
              pending={undoPending}
              pendingLabel="Undoing…"
              onClick={onUndo}
            >
              {removed.length > 0 ? 'Try undo again' : 'Undo import'}
            </Button>
          )}
          <Button variant="primary" onClick={onClose} disabled={undoPending}>
            Done
          </Button>
        </>
      }
    >
      <div className="codex-import__picker" aria-live="polite">
        <p className="codex-import__result-heading">{heading}</p>
        <ul className="codex-import__rows">
          {attempted.map((item) => {
            const name = item.reviewedTarget ?? item.sourceId;
            const tone =
              item.outcome === 'imported'
                ? 'positive'
                : item.outcome === 'rolled-back'
                  ? 'neutral'
                  : 'caution';
            const label =
              item.outcome === 'imported'
                ? 'Imported'
                : item.outcome === 'rolled-back'
                  ? 'Removed'
                  : item.outcome === 'indeterminate'
                    ? 'Check Skills'
                    : 'Not imported';
            return (
              <li key={item.sourceId} className="codex-import__row">
                <div className="codex-import__detail">
                  <span className="codex-import__name">{name}</span>
                  <Badge value={label} tone={tone} />
                </div>
                {item.outcome === 'failed' && (
                  <p className="codex-import__conflict-text">
                    {notImportedReason(item)}
                  </p>
                )}
                {item.outcome === 'imported' &&
                  item.rollback.state === 'conflict' && (
                    <p className="codex-import__conflict-text">
                      This skill changed after the import, so undo left it in
                      place.
                    </p>
                  )}
                {item.outcome === 'indeterminate' && (
                  <p className="codex-import__conflict-text">
                    Station could not confirm this one. Open Skills to check it.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        {undoError && (
          <ErrorState
            variant="compact"
            title="Undo did not finish"
            description={`${undoError} Check Skills before trying again.`}
          />
        )}
      </div>
    </Dialog>
  );
}
