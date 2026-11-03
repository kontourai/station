import { useId } from 'react';
import { useDeviceSettings } from '../../contexts/DeviceSettingsContext';
import { useDockSlotDevice } from '../../hooks/useIsMobile';
import {
  composerReturnSends,
  isComposerSubmitKey,
} from '../../lib/composerReturnKey';
import { Button } from '../Button';

export function SessionReplyComposer({
  input,
  onInputChange,
  onSend,
  busy,
  pending,
  disabled = false,
  allowDraftWhileBusy = false,
  label = 'Send input to session',
  placeholder = 'Reply…',
}: {
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  busy: boolean;
  pending: boolean;
  disabled?: boolean;
  allowDraftWhileBusy?: boolean;
  label?: string;
  placeholder?: string;
}) {
  const noteId = useId();
  const { chatReturnBehavior } = useDeviceSettings();
  const { coarsePointer } = useDockSlotDevice();
  const canSend = !!input.trim() && !busy && !pending && !disabled;
  return (
    <>
      <form
        className="sessions-detail__compose"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) onSend();
        }}
      >
        <textarea
          className="sessions-detail__input"
          aria-label={label}
          placeholder={placeholder}
          aria-describedby={busy ? noteId : undefined}
          value={input}
          disabled={(!allowDraftWhileBusy && busy) || disabled}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              isComposerSubmitKey(
                event,
                composerReturnSends(chatReturnBehavior, coarsePointer),
              )
            ) {
              event.preventDefault();
              if (canSend) onSend();
            }
          }}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={!canSend}
          pending={pending}
          pendingLabel="Sending…"
        >
          Send
        </Button>
      </form>
      {busy && (
        <p id={noteId} className="sessions-detail__note">
          You can reply when the current turn finishes.
        </p>
      )}
    </>
  );
}
