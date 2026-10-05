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
  appearance?: 'button' | 'toolbar-icon';
};

/** Shared creation action for dock, inbox, mobile and Coding chrome. */
export function NewChatAction({
  className = '',
  children = 'New chat',
  iconOnly = false,
  appearance = 'button',
  title,
  ...props
}: NewChatActionProps) {
  if (appearance === 'toolbar-icon') {
    const {
      variant: _variant,
      size: _size,
      pending: _pending,
      pendingLabel: _pendingLabel,
      active: _active,
      ...rest
    } = props;
    return (
      <button
        type="button"
        className={`app-toolbar__icon-btn new-chat-action new-chat-action--icon ${className}`}
        aria-label="New chat"
        title={title ?? 'New chat'}
        {...rest}
      >
        <NewChatGlyph />
      </button>
    );
  }
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
