import type { ComponentProps } from 'react';
import { Button } from './Button';
import './IconButton.css';

type IconButtonProps = Omit<ComponentProps<typeof Button>, 'variant'> & {
  /** Icon-only: the accessible name is the label. */
  'aria-label': string;
};

/**
 * The shared icon-only control: the ghost Button as a 30px round icon with
 * an accent wash on hover. A surface that needs a touch target sizes it up
 * through `--icon-button-size` (the Browser pane under `data-coarse` /
 * `data-narrow`, its page-dialog card on a coarse pointer) or gives it a
 * hit area of its own (the File Preview's bar); the floors live in each
 * pane's sheet. Its look rides this component's own sheet, not the eager
 * `index.css`: every user lazy-loads it, and no first paint draws one. The
 * `icon-button` class is also what an `ActionOverflowMenu` trigger wears
 * when it stands in a row of these.
 */
export function IconButton({ className, ...props }: IconButtonProps) {
  return (
    <Button
      variant="ghost"
      className={className ? `icon-button ${className}` : 'icon-button'}
      {...props}
    />
  );
}
