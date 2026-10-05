import { Tooltip } from '@kontourai/ui/react';
import type { ComponentProps } from 'react';
import { Button } from './Button';
import { EditGlyph } from './icons/Glyph';
import './NewChatAction.css';

type NewChatActionProps = Omit<
  ComponentProps<typeof Button>,
  'children' | 'title'
> & {
  children?: string;
  /** The hint (with its chord); a native title, or the tooltip when icon-only. */
  title?: string;
  /**
   * The glyph alone, named "New chat" and tipped by `title`: for a bar that
   * already names the pane (the Coding workbench bar), where a worded verb
   * would spend the title's width. Still this one action, not a second
   * button.
   */
  iconOnly?: boolean;
};

/** The same creation action in dock, inbox, mobile and Coding chrome. */
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
          <EditGlyph />
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
      <EditGlyph />
      <span>{children}</span>
    </Button>
  );
}
