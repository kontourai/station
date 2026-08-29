/**
 * #765 F8: the shared "no directory bound here" label. Surfaces used to print
 * the machine-framed literal "~ (defaults to home)" (monospace, italic) in
 * prime UI real estate — status bar, dock header, workspace picker. The
 * visible text is now plain copy; the tilde path the old label carried stays
 * reachable as the tooltip so the concrete answer is never lost.
 *
 * One component on purpose: every surface that says "your home folder" says
 * it with the same words, and a future copy change lands everywhere at once.
 */
export const HOME_FOLDER_LABEL = 'Home folder';

export function HomeFolderLabel({
  className,
  title = '~',
}: {
  className?: string;
  /** The path (or path explanation) preserved for hover/assistive detail. */
  title?: string;
}) {
  return (
    <span className={className} title={title}>
      {HOME_FOLDER_LABEL}
    </span>
  );
}
