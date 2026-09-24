/**
 * The preview dialog's Download action: a compact icon link that sits at the
 * end of the viewer's own toolbar instead of claiming a row of its own. The
 * name is real (visually hidden) text carrying the file name, since the icon
 * alone does not.
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
      title={`Download ${name}`}
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" focusable="false">
        <path d="M10 3v10M5.5 8.5 10 13l4.5-4.5M4 16.5h12" />
      </svg>
      <span className="sr-only">Download {name}</span>
    </a>
  );
}
