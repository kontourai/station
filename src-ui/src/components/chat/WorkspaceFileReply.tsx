import {
  isWorkspaceFilePreviewImageDataUrl,
  type WorkspaceVisualFileUnavailableReason,
} from '@kontourai/station-contracts/workspace-file-preview';
import {
  readProjectWorkspaceVisualFile,
  WorkspaceVisualFileError,
} from '@kontourai/station-sdk/workspace-file-preview';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useDeviceSettings } from '../../contexts/DeviceSettingsContext';
import { useOptionalPreview } from '../../contexts/PreviewContext';
import { Button } from '../Button';
import { ArrowDownGlyph, ArrowRightGlyph, WarningGlyph } from '../icons/Glyph';
import { SkeletonBlock } from '../state';
import { HtmlReply } from './HtmlReply';
import { useMarkdownLinkContext } from './MarkdownLinkContext';

export function workspaceVisualPath(href: string | undefined): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//'))
    return null;
  const path = href.split('#')[0];
  return /\.(?:html?|png|jpe?g|gif|webp)$/i.test(path) ? path : null;
}

/** Why a visual file could not be shown, for a reader. */
export type VisualFileFailure =
  | WorkspaceVisualFileUnavailableReason
  /** The request never got an answer (offline, aborted, timed out). */
  | 'unreachable';

/** One short sentence per reason. */
export function visualFileFailureText(reason: VisualFileFailure): string {
  switch (reason) {
    case 'missing':
      return 'The file is not on the Station host.';
    case 'outside-project':
      return "It is outside this Project's folders.";
    case 'unsupported-type':
      return 'Only PNG images and HTML pages show here.';
    case 'too-large':
      return 'The file is too large to show here.';
    case 'no-workspace':
      return 'This chat has no Project folder to read.';
    case 'unreadable':
      return 'Station could not read the file.';
    case 'unauthorized':
      return 'Sign in to this Station again to see it.';
    case 'server-error':
      return 'Station had an error reading it.';
    case 'unreachable':
      return 'Station did not answer.';
    default:
      return 'This Station cannot show this file.';
  }
}

/** Reasons that may clear without the file or reply changing. */
const RETRYABLE: ReadonlySet<VisualFileFailure> = new Set([
  'missing',
  'unreadable',
  'unauthorized',
  'server-error',
  'unreachable',
  'unavailable',
]);

export function visualFileFailureOf(error: unknown): VisualFileFailure {
  return error instanceof WorkspaceVisualFileError
    ? error.reason
    : 'unreachable';
}

/**
 * An inline card for a visual a reply named that this device cannot show:
 * what it was, why, and a retry when the reason may clear.
 */
export function VisualUnavailableCard({
  label,
  reason,
  onRetry,
}: {
  label: ReactNode;
  reason: string;
  onRetry?: () => void;
}) {
  return (
    <span className="markdown-image-unavailable" role="note">
      <WarningGlyph aria-hidden="true" />
      <span className="markdown-image-unavailable__text">
        {label ? <strong>{label}</strong> : null}
        <span>{reason}</span>
      </span>
      {onRetry ? (
        <Button
          variant="ghost"
          size="sm"
          className="markdown-image-unavailable__retry"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onRetry();
          }}
        >
          Retry
        </Button>
      ) : null}
    </span>
  );
}

/**
 * A host path is read through Project authority, never used as a navigation
 * URL. An image reply shows its alt text as a caption under the picture; a
 * link shows its text. Either way the label sits beside a Hide/Show
 * disclosure, not as a link.
 */
export function WorkspaceFileReply({
  path,
  children,
  variant = 'link',
}: {
  path: string;
  children: ReactNode;
  /** `image`: a Markdown image, whose label is its alt text. */
  variant?: 'image' | 'link';
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
  const fileName = path.split('/').at(-1) || 'Image';
  const label = children || fileName;
  if (query.error) {
    const failure = visualFileFailureOf(query.error);
    return (
      <span className="workspace-file-reply">
        <VisualUnavailableCard
          label={label}
          reason={visualFileFailureText(failure)}
          onRetry={
            RETRYABLE.has(failure) ? () => void query.refetch() : undefined
          }
        />
      </span>
    );
  }
  const caption = (
    <span className="workspace-file-reply__caption">
      <span className="workspace-file-reply__label">{label}</span>
      <Button
        variant="ghost"
        size="sm"
        className="workspace-file-reply__toggle"
        aria-expanded={visible}
        aria-label={`${visible ? 'Hide' : 'Show'} ${typeof label === 'string' ? label : fileName}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setVisible((value) => !value);
        }}
      >
        {visible ? (
          <ArrowDownGlyph aria-hidden="true" />
        ) : (
          <ArrowRightGlyph aria-hidden="true" />
        )}
        {visible ? 'Hide' : 'Show'}
      </Button>
    </span>
  );
  const content = visible && (
    <span className="workspace-file-reply__content">
      {!scope?.isCurrent() || !link?.projectSlug ? (
        <VisualUnavailableCard
          label={null}
          reason="This file needs an active Project connection to preview."
        />
      ) : !visual ? (
        <SkeletonBlock count={1} label="Loading visual preview" />
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
              name: fileName,
            });
          }}
        >
          <img
            className="markdown-image"
            src={image}
            alt={typeof children === 'string' && children ? children : fileName}
          />
        </button>
      ) : (
        <VisualUnavailableCard
          label={null}
          reason={visualFileFailureText('unsupported-type')}
        />
      )}
    </span>
  );
  return (
    <span className={`workspace-file-reply workspace-file-reply--${variant}`}>
      {variant === 'image' ? (
        <>
          {content}
          {caption}
        </>
      ) : (
        <>
          {caption}
          {content}
        </>
      )}
    </span>
  );
}
