import { Tooltip } from '@kontourai/ui/react';
import type { ComponentProps } from 'react';
import { Button } from './Button';
import { NewChatGlyph } from './icons/Glyph';
import './NewChatAction.css';

type NewChatActionProps = Omit<
  ComponentProps<typeof Button>,
  'children' | 'title'
> & {
  children?: string;
  title?: string;
  iconOnly?: boolean;
};

/** Shared creation action for dock, inbox, mobile and Coding chrome. */
export function NewChatAction({
  className = '',
  children = 'New chat',
  iconOnly = false,
  title,
  ...props
}: NewChatActionProps) {
  if (iconOnly) {
    return (
      <Tooltip label={title ?? 'New chat'} placement="bottom">
        <Button
          variant="ghost"
          className={`new-chat-action new-chat-action--icon ${className}`}
          aria-label="New chat"
          {...props}
        >
          <NewChatGlyph />
        </Button>
      </Tooltip>
    );
  }
  return (
    <Button
      variant="primary"
      className={`new-chat-action ${className}`}
      aria-label="New chat"
      title={title}
      {...props}
    >
      <NewChatGlyph />
      <span>{children}</span>
    </Button>
  );
}
