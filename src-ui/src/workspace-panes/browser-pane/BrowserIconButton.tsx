import type { ComponentProps } from 'react';
import { Button } from '../../components/Button';
import './BrowserIconButton.css';

type BrowserIconButtonProps = Omit<ComponentProps<typeof Button>, 'variant'> & {
  /** Icon-only: the accessible name is the label. */
  'aria-label': string;
};

/**
 * An icon-only control of the Browser pane and its page-dialog card (#90):
 * the shared ghost Button as a 30px round icon that a touch surface sizes up
 * to 44px through `--browser-pane-control`. Its look rides this component's
 * own sheet, not the eager `index.css`: the pane and the float-over-chat both
 * lazy-load it, and no first paint draws one.
 */
export function BrowserIconButton({
  className,
  ...props
}: BrowserIconButtonProps) {
  return (
    <Button
      variant="ghost"
      className={
        className ? `browser-pane__icon ${className}` : 'browser-pane__icon'
      }
      {...props}
    />
  );
}
