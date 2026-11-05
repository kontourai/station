import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import type { ConversationCapabilityDecision } from '../../connections/station-connection';
import { describeStationFailure } from '../../utils/stationFailure';
import { Button } from '../Button';
import { ComposerStopButton } from '../chat/ComposerStopButton';
import { ConfirmModal } from '../modals/ConfirmModal';

type StopIntent = { kind: 'turn' } | { kind: 'task'; name?: string };

interface StopProps {
  title?: string;
  intent?: StopIntent;
  onCancel: () => unknown;
  stopPending?: boolean;
  capability?: ConversationCapabilityDecision;
  disabled?: boolean;
  children?: ReactNode;
  /** A list menu can open the same confirmation without another trigger. */
  confirmation?: { open: boolean; onClose: () => void; message: string };
  error?: unknown;
}

/** Turn interruption uses the controller's keyed cancel; Task stop stays confirmed. */
export function ConversationStopControl({
  title,
  intent = { kind: 'turn' },
  onCancel,
  stopPending = false,
  capability,
  disabled = false,
  children,
  confirmation,
  error,
}: StopProps) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const inFlight = useRef(false);
  const allowed = !disabled && (!capability || capability.state === 'allowed');
  const pending = stopPending || busy;
  const close = () => {
    if (pending) return;
    setOpen(false);
    setFailure(undefined);
    confirmation?.onClose();
  };
  const stop = async () => {
    if (!allowed || pending || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(undefined);
    try {
      await onCancel();
      setOpen(false);
    } catch (cause) {
      setFailure(cause);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  useLayoutEffect(() => {
    const element = button.current;
    const composer = element?.closest('.chat-input');
    return () => {
      if (element && document.activeElement === element)
        queueMicrotask(() => {
          const draft =
            composer?.querySelector<HTMLTextAreaElement>('textarea');
          if (
            draft?.isConnected &&
            !draft.disabled &&
            document.activeElement === document.body
          )
            draft.focus();
        });
    };
  }, []);
  const confirmed = intent.kind === 'task' || confirmation !== undefined;
  return (
    <>
      {!confirmation &&
        (intent.kind === 'turn' && !children ? (
          <ComposerStopButton
            onCancel={() => {
              if (allowed) void stop();
            }}
            disabled={!allowed}
            stopPending={pending}
            buttonRef={button}
          />
        ) : (
          <Button
            title={title}
            ref={button}
            size="sm"
            variant="ghost"
            disabled={!allowed || pending}
            onClick={() => {
              if (confirmed) setOpen(true);
              else void stop();
            }}
          >
            {children ?? 'Stop'}
          </Button>
        ))}
      {confirmed && (
        <ConfirmModal
          isOpen={confirmation?.open ?? open}
          role="alertdialog"
          variant="danger"
          title={intent.kind === 'task' ? 'Stop this task?' : 'Stop this turn?'}
          message={
            confirmation?.message ??
            (intent.kind === 'task' && intent.name
              ? `Stop “${intent.name}” and its delegated work?`
              : 'This stops the task and its delegated work. You can continue it afterwards.')
          }
          confirmLabel="Stop"
          pending={pending}
          confirmDisabled={!allowed}
          error={
            failure || error
              ? describeStationFailure(failure ?? error).body
              : null
          }
          onCancel={close}
          onConfirm={() => void stop()}
        />
      )}
      {!confirmed && failure && (
        <span role="alert">{describeStationFailure(failure).body}</span>
      )}
    </>
  );
}
