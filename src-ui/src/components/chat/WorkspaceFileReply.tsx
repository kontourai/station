import { isWorkspaceFilePreviewImageDataUrl } from '@kontourai/station-contracts/workspace-file-preview';
import { readProjectWorkspaceVisualFile } from '@kontourai/station-sdk/workspace-file-preview';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useDeviceSettings } from '../../contexts/DeviceSettingsContext';
import { useOptionalPreview } from '../../contexts/PreviewContext';
import { Button } from '../Button';
import { HtmlReply } from './HtmlReply';
import { useMarkdownLinkContext } from './MarkdownLinkContext';

export function workspaceVisualPath(href: string | undefined): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//'))
    return null;
  const path = href.split('#')[0];
  return /\.(?:html?|png|jpe?g|gif|webp)$/i.test(path) ? path : null;
}

/** A host path is read through Project authority, never used as a navigation URL. */
export function WorkspaceFileReply({
  path,
  children,
}: {
  path: string;
  children: ReactNode;
}) {
  const link = useMarkdownLinkContext();
  const scope = useHostRequestAuthorityScope();
  const { theme } = useDeviceSettings();
  const inspector = useOptionalPreview();
  const [visible, setVisible] = useState(true);
  const query = useQuery({
    queryKey: [
      'workspace-visual-file',
      scope?.apiBase,
      scope?.authorityKey,
      link?.projectSlug,
      path,
      link?.threadId,
    ],
    enabled: !!scope?.isCurrent() && !!link?.projectSlug && visible,
    queryFn: ({ signal }) =>
      readProjectWorkspaceVisualFile(
        scope!.apiBase,
        link!.projectSlug!,
        path,
        { signal, requestScope: scope },
        link?.threadId ?? undefined,
      ),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const visual = scope?.isCurrent() && !query.error ? query.data : undefined;
  const image =
    visual?.kind === 'image' &&
    isWorkspaceFilePreviewImageDataUrl(
      visual.preview.dataUrl,
      visual.preview.mimeType,
    )
      ? visual.preview.dataUrl
      : null;
  return (
    <span className="workspace-file-reply">
      <Button
        variant="link"
        aria-expanded={visible}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setVisible((value) => !value);
        }}
      >
        {children}
      </Button>
      {visible && (
        <span className="workspace-file-reply__content">
          {query.error ? (
            <span role="status">{query.error.message}</span>
          ) : !scope?.isCurrent() || !link?.projectSlug ? (
            <span role="status">
              This file needs an active Project connection to preview.
            </span>
          ) : !visual ? (
            <span role="status">Loading visual preview…</span>
          ) : visual.kind === 'html' ? (
            <HtmlReply
              page={visual.page}
              frameOrigin={visual.frameOrigin ?? ''}
              theme={theme}
            />
          ) : image ? (
            <button
              type="button"
              className="markdown-image-button"
              aria-label="Expand image preview"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                inspector?.openPreview({
                  url: image,
                  mediaType:
                    visual?.kind === 'image'
                      ? (visual.preview.mimeType ?? 'image/png')
                      : 'image/png',
                  name: path.split('/').at(-1) ?? 'Image',
                });
              }}
            >
              <img
                className="markdown-image"
                src={image}
                alt={path.split('/').at(-1) ?? 'Image'}
              />
            </button>
          ) : (
            <span role="status">This image cannot be previewed.</span>
          )}
        </span>
      )}
    </span>
  );
}
