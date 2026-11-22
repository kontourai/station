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
 *
 * Undo is the server's rollback of this import's receipt. The receipt id
 * lives only in this dialog, so undo is offered until the dialog closes.
 */

import type {
  ExistingSetupImportEntry,
  ExistingSetupImportOutcome,
  ExistingSetupImportReceipt,
} from '@kontourai/station-sdk/setup-imports';
import {
  useApplySetupImportMutation,
  useCreateSetupImportPreviewMutation,
  useReviewSetupImportTargetsMutation,
  useRollbackSetupImportMutation,
} from '@kontourai/station-sdk/setup-imports-query';
import { SETUP_IMPORT_MAX_ITEMS } from '@kontourai/station-shared/setup-import-bounds';
import { Badge } from '@kontourai/ui/react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { userFacingErrorMessage } from '../../utils/errorText';
import { Button } from '../Button';
import { Checkbox } from '../Checkbox';
import { Dialog } from '../Dialog';
import { Empty, ErrorState, SkeletonBlock } from '../state';
import { importNameProblem, planImportNames } from './codex-import-names';
import './CodexPromptImportDialog.css';

const SOURCE_ID = 'codex-prompts';
const TITLE = 'Import your Codex prompts as skills';
const CLOSE_LABEL = 'Close Codex import';

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

/** The files the preview left out, split by whether the cap was the reason. */
function excludedNotes(excluded: Record<string, number>): string[] {
  const capped = excluded['count-limit'] ?? 0;
  const other = Object.entries(excluded)
    .filter(([reason]) => reason !== 'count-limit')
    .reduce((total, [, count]) => total + count, 0);
  return [
    ...(capped > 0
      ? [
          `${capped} more prompt${capped === 1 ? ' was' : 's were'} left out: Station imports up to ${SETUP_IMPORT_MAX_ITEMS} prompts at a time.`,
        ]
      : []),
    ...(other > 0
      ? [
          `${other} other file${other === 1 ? '' : 's'} in the Codex prompts folder can’t be imported.`,
        ]
      : []),
  ];
}

function isFullFolderRefusal(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'TOO_MANY_FILES'
  );
}

interface CodexPromptImportDialogProps {
  open: boolean;
  onClose: () => void;
  /** Every skill name the person already has, built-in ones included. */
  existingSkillNames: readonly string[];
}

export function CodexPromptImportDialog({
  open,
  onClose,
  existingSkillNames,
}: CodexPromptImportDialogProps) {
  if (!open) return null;
  // Portalled for the same reason as the Skills page's other import dialog:
  // its trigger lives in the list pane, which a phone marks inert while a
  // skill sheet is open.
  return createPortal(
    <CodexPromptImportBody
      onClose={onClose}
      existingSkillNames={existingSkillNames}
    />,
    document.body,
  );
}

function CodexPromptImportBody({
  onClose,
  existingSkillNames,
}: Omit<CodexPromptImportDialogProps, 'open'>) {
  const previewMutation = useCreateSetupImportPreviewMutation();
  const reviewMutation = useReviewSetupImportTargetsMutation();
  const applyMutation = useApplySetupImportMutation();
  const rollbackMutation = useRollbackSetupImportMutation();
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [edited, setEdited] = useState<Record<string, boolean>>({});
  const [receipt, setReceipt] = useState<ExistingSetupImportReceipt>();
  const preview = previewMutation.data;
  const createPreview = previewMutation.mutate;
  const entries = preview?.entries ?? [];
  // Planned once per preview, against the names known when it arrived.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a later skills refetch must not rewrite names the person is editing.
  const plan = useMemo(
    () => planImportNames(entries, existingSkillNames),
    [preview],
  );

  // A fresh look at the prompts folder each time the dialog opens.
  useEffect(() => {
    createPreview(SOURCE_ID);
  }, [createPreview]);

  // Nothing is pre-selected. A row that cannot keep its own name starts with
  // the first free one, so ticking it is enough to import it.
  useEffect(() => {
    if (!preview) return;
    setSelected({});
    setEdited({});
    setTargets(
      Object.fromEntries(
        preview.entries.map((entry) => [
          entry.id,
          plan.get(entry.id)?.suggested ?? entry.skillName,
        ]),
      ),
    );
    setReceipt(undefined);
  }, [preview, plan]);

  const chosen = entries.filter((entry) => selected[entry.id]);
  const problemFor = (id: string) =>
    importNameProblem(
      targets[id] ?? '',
      existingSkillNames,
      chosen
        .filter((other) => other.id !== id)
        .map((other) => targets[other.id] ?? ''),
    );
  const invalidChoice = chosen.some((entry) => problemFor(entry.id));
  const importing = reviewMutation.isPending || applyMutation.isPending;
  const allSelected = entries.length > 0 && chosen.length === entries.length;

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

  if (receipt) {
    return (
      <ImportResult
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
      title={TITLE}
      subtitle={
        entries.length > 0
          ? `Station found ${entries.length} saved prompt${entries.length === 1 ? '' : 's'} in Codex. Pick the ones you want.`
          : undefined
      }
      closeLabel={CLOSE_LABEL}
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
        isFullFolderRefusal(previewMutation.error) ? (
          <ErrorState
            variant="compact"
            title="Your Codex prompts folder has too many files"
            description="Station can’t read a folder this full. Move some files out of it, then open this again."
          />
        ) : (
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
        )
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
            {entries.map((entry) => (
              <PromptRow
                key={entry.id}
                entry={entry}
                clash={plan.get(entry.id)?.clash}
                checked={selected[entry.id] ?? false}
                target={targets[entry.id] ?? ''}
                problem={selected[entry.id] ? problemFor(entry.id) : undefined}
                showRename={Boolean(
                  plan.get(entry.id)?.clash ||
                    edited[entry.id] ||
                    (selected[entry.id] && problemFor(entry.id)),
                )}
                disabled={importing}
                onCheck={(next) =>
                  setSelected((current) => ({ ...current, [entry.id]: next }))
                }
                onRename={(value) => {
                  setTargets((current) => ({ ...current, [entry.id]: value }));
                  setEdited((current) => ({ ...current, [entry.id]: true }));
                  // Typing a name is choosing to import the prompt.
                  setSelected((current) => ({ ...current, [entry.id]: true }));
                }}
              />
            ))}
          </ul>
          {preview &&
            excludedNotes(preview.excluded).map((note) => (
              <p key={note} className="codex-import__note">
                {note}
              </p>
            ))}
          <p className="codex-import__note">
            Each prompt becomes a new skill, and your Codex files don’t change.
            You can undo the whole import before you close this window.
          </p>
          {(reviewMutation.isError || applyMutation.isError) && (
            <ErrorState
              variant="compact"
              title="Import did not finish"
              description={`${userFacingErrorMessage(
                reviewMutation.error ?? applyMutation.error,
              )} Some skills may have been created: open Skills to check, and remove any you don’t want.`}
            />
          )}
        </div>
      )}
    </Dialog>
  );
}

interface PromptRowProps {
  entry: ExistingSetupImportEntry;
  clash?: 'existing' | 'duplicate';
  checked: boolean;
  target: string;
  problem?: string;
  showRename: boolean;
  disabled: boolean;
  onCheck: (next: boolean) => void;
  onRename: (value: string) => void;
}

/** One prompt: its tick box, where it came from, and its name when it needs one. */
function PromptRow({
  entry,
  clash,
  checked,
  target,
  problem,
  showRename,
  disabled,
  onCheck,
  onRename,
}: PromptRowProps) {
  const messageId = `codex-import-message-${entry.id}`;
  const errorId = `codex-import-error-${entry.id}`;
  return (
    <li className="codex-import__row">
      <div className="codex-import__head">
        <Checkbox
          id={`codex-import-${entry.id}`}
          checked={checked}
          disabled={disabled}
          onChange={onCheck}
        >
          <span className="codex-import__name">{entry.skillName}</span>
        </Checkbox>
        <Badge
          value={clash ? 'Needs a name' : 'New skill'}
          tone={clash ? 'caution' : 'neutral'}
        />
      </div>
      <p className="codex-import__detail">From {entry.name}</p>
      {showRename && (
        <div className="codex-import__conflict">
          {clash && (
            <p id={messageId} className="codex-import__conflict-text">
              {clash === 'existing'
                ? `You already have a skill called “${entry.skillName}”.`
                : `Another prompt here is also called “${entry.skillName}”.`}{' '}
              Choose a new name to import it.
            </p>
          )}
          <input
            className="editor-input codex-import__rename"
            aria-label={`New name for ${entry.skillName}`}
            aria-describedby={
              [clash ? messageId : '', problem ? errorId : '']
                .filter(Boolean)
                .join(' ') || undefined
            }
            aria-invalid={problem ? true : undefined}
            value={target}
            disabled={disabled}
            onChange={(event) => onRename(event.target.value)}
          />
        </div>
      )}
      {problem && (
        <p id={errorId} className="codex-import__error">
          {problem}
        </p>
      )}
    </li>
  );
}

interface ImportResultProps {
  receipt: ExistingSetupImportReceipt;
  undoPending: boolean;
  undoError?: string;
  onUndo: () => void;
  onClose: () => void;
}

function resultHeading(
  undone: boolean,
  imported: number,
  removed: number,
): string {
  if (undone) return `Import undone. ${skillCount(removed)} removed.`;
  if (removed > 0)
    return `Undo removed ${skillCount(removed)}. ${skillCount(imported)} could not be removed.`;
  if (imported === 0) return 'Nothing was imported.';
  return `Imported ${skillCount(imported)}.`;
}

/** What happened, per prompt, read from the server's record of the import. */
function ImportResult({
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

  return (
    <Dialog
      title={TITLE}
      closeLabel={CLOSE_LABEL}
      onClose={onClose}
      size="lg"
      panelClassName="codex-import"
      footer={
        <>
          {canUndo && (
            <p className="codex-import__footnote">
              Closing this window ends undo.
            </p>
          )}
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
        <p className="codex-import__result-heading">
          {resultHeading(undone, imported.length, removed.length)}
        </p>
        <ul className="codex-import__rows">
          {attempted.map((item) => (
            <OutcomeRow key={item.sourceId} item={item} />
          ))}
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

const OUTCOME_LABELS: Record<
  ExistingSetupImportOutcome['outcome'],
  { label: string; tone: 'positive' | 'neutral' | 'caution' }
> = {
  imported: { label: 'Imported', tone: 'positive' },
  'rolled-back': { label: 'Removed', tone: 'neutral' },
  indeterminate: { label: 'Check Skills', tone: 'caution' },
  failed: { label: 'Not imported', tone: 'caution' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};

function OutcomeRow({ item }: { item: ExistingSetupImportOutcome }) {
  const { label, tone } = OUTCOME_LABELS[item.outcome];
  const note =
    item.outcome === 'failed'
      ? notImportedReason(item)
      : item.outcome === 'imported' && item.rollback.state === 'conflict'
        ? 'This skill changed after the import, so undo left it in place.'
        : item.outcome === 'indeterminate'
          ? 'Station could not confirm this one. Open Skills to check it.'
          : undefined;
  return (
    <li className="codex-import__row">
      <div className="codex-import__detail">
        <span className="codex-import__name">
          {item.reviewedTarget ?? item.sourceId}
        </span>
        <Badge value={label} tone={tone} />
      </div>
      {note && <p className="codex-import__conflict-text">{note}</p>}
    </li>
  );
}
