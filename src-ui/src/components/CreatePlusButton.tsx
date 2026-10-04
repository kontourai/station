import type { MouseEvent } from 'react';
import { Button } from './Button';
import { PlusGlyph } from './icons/Glyph';
import './CreatePlusButton.css';

/**
 * The round primary "+" for creating something, shared by the picker footers
 * and the phone form of a page's creation action. Callers own placement; the
 * label is the accessible name.
 */
export function CreatePlusButton({
  label,
  onClick,
  disabled,
  title,
  className,
}: {
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <Button
      variant="primary"
      className={
        className ? `create-plus-button ${className}` : 'create-plus-button'
      }
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
    >
      <PlusGlyph />
    </Button>
  );
}
