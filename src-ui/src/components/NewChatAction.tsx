import type { ComponentProps } from 'react';
import { Button } from './Button';
import { NewChatGlyph } from './icons/Glyph';
import './NewChatAction.css';

/**
 * The same creation action in dock, inbox, and mobile chrome. `toolbar-icon`
 * renders it as an icon-only control in the toolbar's own button family, so
 * it matches the header buttons beside it instead of a filled primary.
 */
export function NewChatAction({
  className = '',
  children = 'New chat',
  appearance = 'button',
  ...props
}: Omit<ComponentProps<typeof Button>, 'children'> & {
  children?: string;
  appearance?: 'button' | 'toolbar-icon';
}) {
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
        title="New chat"
        {...rest}
      >
        <NewChatGlyph />
      </button>
    );
  }
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
