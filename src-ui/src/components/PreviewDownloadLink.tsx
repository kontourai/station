/**
 * The preview dialog's Download action: a compact icon link that sits at the
 * end of the viewer's own toolbar instead of claiming a row of its own. The
 * accessible name carries the file name, since the icon alone does not.
 */
export function PreviewDownloadLink({
  href,
  name,
}: {
  href: string;
  name: string;
}) {
  return (
    <a
      className="button button--ghost preview-download"
      href={href}
      download={name}
      aria-label={`Download ${name}`}
      title="Download"
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" focusable="false">
        <path d="M10 3v10M5.5 8.5 10 13l4.5-4.5M4 16.5h12" />
      </svg>
    </a>
  );
}
