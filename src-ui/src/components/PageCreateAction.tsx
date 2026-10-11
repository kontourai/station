import type { MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useIsMobile } from '../hooks/useIsMobile';
import { Button } from './Button';
import { CreatePlusButton } from './CreatePlusButton';
import { PageFrameActions } from './page-frame';
import './PageCreateAction.css';

/**
 * A page's one creation action. On desktop it is the labelled primary button
 * in the page header's action cell. On a phone the stacked header would give
 * it a row of its own, so it becomes a floating "+" in the bottom-right,
 * above the chat dock and safe area, keeping the label as its accessible
 * name. Use it only for creating something; other page actions stay in the
 * header.
 */
export function PageCreateAction({
  label,
  onClick,
  disabled = false,
  disabledReason,
}: {
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  /** Shown as the control's title when `disabled`, so the refusal says why. */
  disabledReason?: string;
}) {
  const isMobile = useIsMobile();
  const title = disabled && disabledReason ? disabledReason : undefined;
  if (!isMobile)
    return (
      <PageFrameActions>
        <Button
          variant="primary"
          size="sm"
          disabled={disabled}
          title={title}
          onClick={onClick}
        >
          {label}
        </Button>
      </PageFrameActions>
    );
  // Portaled: the page frame's entrance animation would otherwise become the
  // containing block for `position: fixed`.
  return createPortal(
    <div className="page-create-action">
      <CreatePlusButton
        label={label}
        title={title}
        disabled={disabled}
        onClick={onClick}
      />
    </div>,
    document.body,
  );
}
