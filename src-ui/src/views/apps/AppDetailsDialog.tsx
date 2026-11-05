import type { LayoutMetadata } from '@kontourai/station-contracts/layout';
import {
  useCreatePersonalLayoutMutation,
  useUpdatePersonalLayoutMutation,
} from '@kontourai/station-sdk';
import { useId, useState } from 'react';
import { boardSlugFromName, nextBoardSlug } from '../../app-shell/board-slug';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { ErrorState } from '../../components/state';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';

export function AppDetailsDialog({
  board,
  takenSlugs,
  onClose,
  onSaved,
}: {
  board?: LayoutMetadata;
  takenSlugs: readonly string[];
  onClose: () => void;
  onSaved: (slug: string, created: boolean) => void;
}) {
  const formId = useId();
  const [name, setName] = useState(board?.name ?? '');
  const [description, setDescription] = useState(board?.description ?? '');
  const [icon, setIcon] = useState(board?.icon ?? '');
  const [saved, setSaved] = useState(false);
  const create = useCreatePersonalLayoutMutation();
  const update = useUpdatePersonalLayoutMutation();
  const pending = create.isPending || update.isPending;
  const mutationError = create.error ?? update.error;
  const dirty =
    !saved &&
    (name !== (board?.name ?? '') ||
      description !== (board?.description ?? '') ||
      icon !== (board?.icon ?? ''));
  const { guard, DiscardModal } = useUnsavedGuard(dirty);
  const close = () => {
    if (!pending) guard(onClose);
  };

  return (
    <>
      <Dialog
        title={board ? 'Edit app details' : 'New Board'}
        subtitle={
          board
            ? undefined
            : 'Create a personal dashboard, then choose its sections.'
        }
        closeLabel="Close app details"
        onClose={close}
        dismissible={!pending}
        historyMode="none"
        footer={
          <>
            <Button disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              form={formId}
              disabled={pending || !name.trim() || (Boolean(board) && !dirty)}
            >
              {pending ? 'Saving…' : board ? 'Save details' : 'Create Board'}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          className="apps-library__form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending || !name.trim()) return;
            const details = {
              name: name.trim(),
              description: description.trim(),
              icon: icon.trim(),
            };
            try {
              const result = board
                ? await update.mutateAsync({
                    layoutSlug: board.slug,
                    update: details,
                  })
                : await create.mutateAsync({
                    ...details,
                    slug:
                      boardSlugFromName(details.name, takenSlugs) ??
                      nextBoardSlug(takenSlugs),
                  });
              setSaved(true);
              onSaved(result.slug, !board);
            } catch {
              // The mutation retains the failure and this draft for inspection.
            }
          }}
        >
          <label>
            Name
            <input
              value={name}
              maxLength={200}
              required
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Icon
            <input
              value={icon}
              maxLength={16}
              placeholder="Emoji or short symbol"
              onChange={(event) => setIcon(event.target.value)}
            />
          </label>
          <label>
            Description
            <textarea
              value={description}
              rows={3}
              maxLength={500}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          {mutationError && (
            <ErrorState
              variant="compact"
              title="Could not save app details"
              description={`${mutationError.message} Refresh the library before retrying an interrupted create.`}
            />
          )}
        </form>
      </Dialog>
      <DiscardModal />
    </>
  );
}
