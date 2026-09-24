import { parseChatAttachmentDataUrl } from '@kontourai/station-contracts/chat-attachment';
import {
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useState,
} from 'react';
import type { Options } from 'react-markdown';
import {
  hostOwnsExternalLinks,
  openNativeExternalLink,
} from '../platform/openExternalLink';
import { attachmentBlobForObjectUrl } from './chat/attachment-object-urls';
import { markdownCodeComponents } from './chat/HighlightedCodeBlock';
import { LazyMarkdown } from './chat/LazyMarkdown';
import { MarkdownImage } from './chat/markdown-images';
import { classifyMarkdownLink } from './chat/markdownLinkTarget';
import type { PreviewItem } from './ImagePreviewContent';
import { Empty, SkeletonBlock } from './state';

/**
 * Characters of a text attachment rendered inline. Attachments are capped at
 * 5 MB, which is well past what a dialog can lay out without stalling a phone;
 * the remainder stays reachable through Download.
 */
export const TEXT_PREVIEW_CHAR_LIMIT = 200_000;

export type FilePreviewKind = 'pdf' | 'markdown' | 'json' | 'text' | 'none';

export function filePreviewKind(mediaType: string): FilePreviewKind {
  const type = mediaType.toLowerCase().split(';')[0].trim();
  if (type === 'application/pdf') return 'pdf';
  if (type === 'text/markdown') return 'markdown';
  if (type === 'application/json') return 'json';
  if (type.startsWith('text/')) return 'text';
  return 'none';
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The bytes behind a preview URL, without fetching it.
 *
 * `fetch('blob:…')` and `fetch('data:…')` are both refused by the desktop and
 * mobile CSP (`connect-src`), so re-reading the URL would work in a browser
 * and fail inside the app. Inline parts decode their data URL; fetched parts
 * hand back the Blob the attachment cache minted the URL from.
 */
export function previewBlob(item: PreviewItem): Blob | undefined {
  if (item.url.startsWith('data:')) {
    const parsed = parseChatAttachmentDataUrl(item.url);
    if (!parsed) return undefined;
    return new Blob([decodeBase64(parsed.base64)], { type: item.mediaType });
  }
  return attachmentBlobForObjectUrl(item.url);
}

type TextState =
  | { status: 'loading' }
  | { status: 'ready'; text: string; truncated: boolean }
  | { status: 'unavailable' };

function useItemText(item: PreviewItem, enabled: boolean): TextState {
  const [state, setState] = useState<TextState>({ status: 'loading' });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setState({ status: 'loading' });
    const blob = previewBlob(item);
    if (!blob) {
      setState({ status: 'unavailable' });
      return;
    }
    blob.text().then(
      (text) => {
        if (!active) return;
        setState({
          status: 'ready',
          text: text.slice(0, TEXT_PREVIEW_CHAR_LIMIT),
          truncated: text.length > TEXT_PREVIEW_CHAR_LIMIT,
        });
      },
      () => {
        if (active) setState({ status: 'unavailable' });
      },
    );
    return () => {
      active = false;
    };
  }, [item, enabled]);
  return state;
}

/**
 * A URL an `<iframe>` can load for a PDF. Blob URLs pass through; an inline
 * data URL is re-minted as a blob URL, because browsers refuse to navigate
 * frames to `data:` documents.
 */
function usePdfFrameUrl(item: PreviewItem, enabled: boolean) {
  const [url, setUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    if (item.url.startsWith('blob:')) {
      setUrl(item.url);
      return;
    }
    // Only bytes Station holds are framed: a blob URL it minted, or inline
    // data re-minted below. A part URL pointing anywhere else would put an
    // arbitrary page in an unsandboxed frame under a "PDF" label.
    if (!item.url.startsWith('data:')) {
      setUrl(undefined);
      return;
    }
    const blob = previewBlob(item);
    if (!blob) {
      setUrl(undefined);
      return;
    }
    const minted = URL.createObjectURL(blob);
    setUrl(minted);
    return () => URL.revokeObjectURL(minted);
  }, [item, enabled]);
  return url;
}

/**
 * Whether this browser renders PDFs itself. `pdfViewerEnabled` is false on
 * engines without a viewer (Android WebView); an engine that predates the
 * property is given the benefit of the doubt, since the frame then shows the
 * engine's own fallback rather than nothing.
 */
function canRenderPdfInline(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    (navigator as Navigator & { pdfViewerEnabled?: boolean })
      .pdfViewerEnabled !== false
  );
}

/**
 * A link inside an attached markdown file. The dialog has no conversation
 * behind it, so repo paths and relative links have nowhere honest to go and
 * render as text: followed, they would resolve against Station's own origin
 * and replace the app. External links leave through the native host where
 * there is one (a plain anchor navigates a Tauri webview away from Station).
 */
function PreviewMarkdownAnchor({
  href,
  children,
  node: _node,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  children?: ReactNode;
  node?: unknown;
}) {
  const target = classifyMarkdownLink(href);
  if (target?.kind !== 'external') return <span>{children}</span>;
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!hostOwnsExternalLinks()) return;
    event.preventDefault();
    void openNativeExternalLink(target.url);
  };
  return (
    <a
      {...props}
      href={target.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={handleClick}
    >
      {children}
    </a>
  );
}

// An explicit map REPLACES the renderer's default, so code highlighting and
// images are carried over here (see MarkdownRenderer).
const previewMarkdownComponents: NonNullable<Options['components']> = {
  ...markdownCodeComponents,
  a: PreviewMarkdownAnchor,
  img: MarkdownImage,
};

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Truncated or malformed JSON still reads better as-is than as nothing.
    return text;
  }
}

/** Non-image preview body: an inline view where one is honest, and always the bytes. */
export default function FilePreviewContent({
  current,
}: {
  current: PreviewItem;
}) {
  const kind = filePreviewKind(current.mediaType);
  const isText = kind === 'markdown' || kind === 'json' || kind === 'text';
  const pdfInline = kind === 'pdf' && canRenderPdfInline();
  const text = useItemText(current, isText);
  const pdfUrl = usePdfFrameUrl(current, pdfInline);
  const name = current.name || 'Attachment';

  let body: ReactNode;
  if (kind === 'pdf') {
    body = pdfInline ? (
      pdfUrl ? (
        <iframe className="file-preview__frame" src={pdfUrl} title={name} />
      ) : (
        <Empty
          label="Preview unavailable"
          description="Station could not read this PDF. Download it to open it."
        />
      )
    ) : (
      <Empty
        label="This device can't show PDFs here"
        description="Download the file to open it in another app."
      />
    );
  } else if (isText) {
    if (text.status === 'loading') {
      body = <SkeletonBlock count={3} label="Loading file preview" />;
    } else if (text.status === 'unavailable') {
      body = (
        <Empty
          label="Preview unavailable"
          description="Station could not read this file. Download it to open it."
        />
      );
    } else {
      body = (
        <div className="file-preview__text">
          {kind === 'markdown' ? (
            <div className="file-preview__markdown">
              <LazyMarkdown components={previewMarkdownComponents}>
                {text.text}
              </LazyMarkdown>
            </div>
          ) : (
            <pre className="file-preview__source">
              <code>{kind === 'json' ? prettyJson(text.text) : text.text}</code>
            </pre>
          )}
          {text.truncated && (
            <p className="file-preview__notice">
              Showing the first {TEXT_PREVIEW_CHAR_LIMIT.toLocaleString()}{' '}
              characters. Download the file to see all of it.
            </p>
          )}
        </div>
      );
    }
  } else {
    body = (
      <Empty
        label="No preview for this file type"
        description={`${current.mediaType} files can't be shown here. Download the file to open it.`}
      />
    );
  }

  return (
    <>
      <div className="file-preview__actions">
        <a
          className="button button--secondary"
          href={current.url}
          download={name}
        >
          Download
        </a>
      </div>
      <div className="file-preview__body">{body}</div>
    </>
  );
}
