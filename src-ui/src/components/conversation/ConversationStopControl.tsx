import { type ComponentProps, useLayoutEffect, useRef } from 'react';
import { ComposerStopButton } from '../chat/ComposerStopButton';

/** Turn interruption uses the controller's keyed cancel; Task stop stays confirmed. */
export function ConversationStopControl(
  props: ComponentProps<typeof ComposerStopButton>,
) {
  const button = useRef<HTMLButtonElement>(null);
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
  return <ComposerStopButton {...props} buttonRef={button} />;
}
