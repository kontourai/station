import { Button } from '../../components/Button';

export function BoardToolbar({
  edit,
  saved,
  actions,
}: {
  edit: {
    preview: boolean;
    valid: boolean;
    changed: boolean;
    pending: boolean;
    proposal: boolean;
  } | null;
  saved: boolean;
  actions: {
    cancel: () => void;
    preview: () => void;
    save: () => void;
    refresh: () => void;
    chat: () => void;
    edit: () => void;
  };
}) {
  return (
    <div className="personal-board__toolbar">
      <div>
        <span>
          {edit
            ? edit.preview
              ? 'Preview · not saved'
              : 'Editing Board'
            : 'Your workspace, across Projects'}
        </span>
        {edit ? (
          <Button disabled={edit.pending} onClick={actions.cancel}>
            Cancel
          </Button>
        ) : (
          <Button onClick={actions.refresh}>Refresh Board</Button>
        )}
      </div>
      <div>
        {edit ? (
          <>
            <Button
              disabled={edit.pending || !edit.valid}
              onClick={actions.preview}
            >
              {edit.preview ? 'Keep editing' : 'Preview'}
            </Button>
            <Button
              variant="primary"
              pending={edit.pending}
              disabled={!edit.valid || edit.changed}
              onClick={actions.save}
            >
              {edit.proposal ? 'Apply Board' : 'Save Board'}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={actions.chat}>Build with chat</Button>
            {saved && (
              <Button variant="primary" onClick={actions.edit}>
                Edit Board
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
