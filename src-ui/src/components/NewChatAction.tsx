import type { ComponentProps } from 'react';
import { Button } from './Button';
import { NewChatGlyph } from './icons/Glyph';
import './NewChatAction.css';

/** The same creation action in dock, inbox, and mobile chrome. */
export function NewChatAction({
  className = '',
  children = 'New chat',
  ...props
}: Omit<ComponentProps<typeof Button>, 'children'> & { children?: string }) {
  return (
    <Button
      variant="primary"
      className={`new-chat-action ${className}`}
      aria-label="New chat"
      {...props}
    >
      <NewChatGlyph />
      <span>{children}</span>
    </Button>
  );
}
