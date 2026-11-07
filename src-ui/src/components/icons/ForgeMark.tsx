export type Forge = 'github' | 'gitlab';

/**
 * The forge whose MARK a host earns. Only the two public hosts: a
 * self-hosted forge may be either (or neither), and showing a brand the
 * host has not proven would be a label nothing derives.
 */
export function forgeForHost(host: string): Forge | null {
  const canonical = host.toLowerCase().replace(/\.$/, '');
  if (canonical === 'github.com' || canonical === 'www.github.com')
    return 'github';
  if (canonical === 'gitlab.com' || canonical === 'www.gitlab.com')
    return 'gitlab';
  return null;
}

export function ForgeMark({
  forge,
  className,
}: {
  forge: Forge;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="currentColor"
      focusable="false"
      height="1em"
      viewBox="0 0 16 16"
      width="1em"
    >
      {forge === 'github' ? (
        <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
      ) : (
        <path d="m15.73 6.34-.02-.06L13.53.6a.57.57 0 0 0-1.08.04l-1.47 4.5H5.02L3.55.64A.57.57 0 0 0 2.47.6L.29 6.28l-.02.06a4.04 4.04 0 0 0 1.34 4.67l.03.03 3.3 2.47 1.63 1.24 1 .75a.67.67 0 0 0 .81 0l1-.75 1.63-1.24 3.32-2.49.01-.01a4.04 4.04 0 0 0 1.34-4.67Z" />
      )}
    </svg>
  );
}
