import type { Ref, TextareaHTMLAttributes } from 'react';

/** The room and its thread share chat keyboard behavior, including IME input. */
export function TaskRoomMessageInput({
  onSend,
  onKeyDown,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  ref?: Ref<HTMLTextAreaElement>;
  onSend(): void;
}) {
  return (
    <textarea
      {...props}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          !event.defaultPrevented &&
          event.key === 'Enter' &&
          !event.shiftKey &&
          !event.nativeEvent.isComposing &&
          event.keyCode !== 229
        ) {
          event.preventDefault();
          onSend();
        }
      }}
    />
  );
}
