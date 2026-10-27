import {
  CHAT_HOST_IMAGES_PREVIEW_ID,
  type ChatHostImage,
  chatHostImageRefusalText,
  hostImagePathFromDestination,
} from '@kontourai/station-contracts/chat-host-images';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { defaultUrlTransform, type UrlTransform } from 'react-markdown';
import { useOptionalPreview } from '../../contexts/PreviewContext';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { WarningGlyph } from '../icons/Glyph';
import { useAttachmentObjectUrlState } from './FilePartPreview';
import { type HostImagesView, useHostImages } from './HostImagesContext';
import { useMarkdownLinkContext } from './MarkdownLinkContext';
import { WorkspaceFileReply, workspaceVisualPath } from './WorkspaceFileReply';

/**
 * An inline image a model wrote as a data URL. Only the raster types chat
 * attachments already allow: SVG is excluded because it is a document, not a
 * picture, and has no business rendering from model output.
 */
const INLINE_IMAGE_DATA_URL =
  /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

/**
 * react-markdown's default transform blanks every `data:` URL, which silently
 * dropped images models return inline (ACP image chunks arrive this way). An
 * `<img src>` data URL cannot run script, so it is admitted for images only;
 * links and every other attribute keep the default policy.
 *
 * A `file:` image URL that names a host image is kept too, so `MarkdownImage`
 * can look it up among the turn's captured host images. It never reaches an
 * `<img>`: without a captured copy the image renders exactly as a blanked
 * URL did before.
 */
export const chatUrlTransform: UrlTransform = (url, key, node) => {
  if (key === 'src' && node.tagName === 'img') {
    if (INLINE_IMAGE_DATA_URL.test(url)) return url;
    if (/^file:/i.test(url) && hostImagePathFromDestination(url)) return url;
  }
  return defaultUrlTransform(url);
};

function mediaTypeOf(src: string): string {
  const match = /^data:([^;,]+)/i.exec(src);
  if (match) return match[1].toLowerCase();
  const extension = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(src)?.[1]?.toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'gif' || extension === 'webp') return `image/${extension}`;
  // The previewer only needs to know it is an image; the bytes decide how the
  // browser decodes them.
  return 'image/png';
}

type ImageProps = ComponentPropsWithoutRef<'img'> & { node?: unknown };

/**
 * A markdown image that opens the shared previewer (zoom, pinch) on click, so
 * an image in a reply is as inspectable as one the user attached. Outside the
 * chat shell — no previewer mounted — it stays a plain image.
 *
 * In an assistant row, a host path (`/abs/path.png` or a `file:` URL) goes to
 * {@link HostPathImage}, which shows Station's stored copy while the
 * chat-host-images preview is on.
 */
export function MarkdownImage(props: ImageProps) {
  const hostImages = useHostImages();
  const source = typeof props.src === 'string' ? props.src : undefined;
  const hostPath = hostImages ? hostImagePathFromDestination(source) : null;
  if (hostImages && hostPath)
    return <HostPathImage {...props} hostImages={hostImages} path={hostPath} />;
  return <LegacyMarkdownImage {...props} />;
}

/** The behaviour before chat-host-images, unchanged while the preview is off. */
function LegacyMarkdownImage({ src, alt, node: _node, ...props }: ImageProps) {
  const preview = useOptionalPreview();
  const link = useMarkdownLinkContext();
  // A `file:` URL only passes the transform for this lookup; here it is
  // blanked exactly as the default transform would have.
  const source =
    typeof src === 'string' && /^file:/i.test(src)
      ? defaultUrlTransform(src)
      : typeof src === 'string'
        ? src
        : undefined;
  const localPath = workspaceVisualPath(source);
  if (link?.projectSlug && localPath) {
    return (
      <WorkspaceFileReply path={localPath}>{alt || 'Image'}</WorkspaceFileReply>
    );
  }
  const image = (
    <img {...props} src={source} alt={alt ?? ''} className="markdown-image" />
  );
  if (!preview || !source) return image;
  const name = alt || 'Image';
  return (
    <PreviewButton name={name} url={source} mediaType={mediaTypeOf(source)}>
      {image}
    </PreviewButton>
  );
}

function PreviewButton({
  name,
  url,
  mediaType,
  children,
}: {
  name: string;
  url: string;
  mediaType: string;
  children: ReactNode;
}) {
  const preview = useOptionalPreview();
  if (!preview) return <>{children}</>;
  return (
    <button
      type="button"
      className="markdown-image-button"
      aria-label={`Preview ${name}`}
      onClick={(event) => {
        // A linked image (`[![alt](src)](href)`) sits inside an anchor; the
        // preview is this click's whole action, not the preview plus a
        // navigation.
        event.preventDefault();
        event.stopPropagation();
        preview.openPreview({ url, mediaType, name });
      }}
    >
      {children}
    </button>
  );
}

/**
 * A host path in an assistant reply. While the preview is on: Station's
 * stored copy when it kept one; the reason when it refused one; for a path it
 * has no record of (a turn from before the preview, or a capture that never
 * ran), the Project's workspace reader when the chat has a Project; and
 * otherwise a plain "not available" chip (while the reply is still streaming,
 * a note that the image comes when it finishes) — never a broken `<img>` pointing at
 * a path this device cannot read. The preview list is fetched once and
 * cached, and is empty (off) until it loads.
 */
function HostPathImage({
  hostImages,
  path,
  ...props
}: ImageProps & { hostImages: HostImagesView; path: string }) {
  const enabled = useSurfaceVisibilityFlags().has(CHAT_HOST_IMAGES_PREVIEW_ID);
  const link = useMarkdownLinkContext();
  if (!enabled) return <LegacyMarkdownImage {...props} />;
  const captured = hostImages.map.images[path];
  if (captured) return <CapturedHostImage image={captured} alt={props.alt} />;
  const refused = hostImages.map.refused[path];
  if (!captured && !refused && !hostImages.settled)
    return (
      <span className="markdown-image-unavailable" role="note">
        Image appears when the reply finishes.
      </span>
    );
  if (!refused && link?.projectSlug && workspaceVisualPath(path))
    return (
      <WorkspaceFileReply path={path}>
        {props.alt || 'Image'}
      </WorkspaceFileReply>
    );
  return (
    <UnavailableHostImage
      alt={props.alt}
      reason={chatHostImageRefusalText(refused)}
    />
  );
}

function CapturedHostImage({
  image,
  alt,
}: {
  image: ChatHostImage;
  alt: string | undefined;
}) {
  const { url, failed } = useAttachmentObjectUrlState(
    image.blobRef,
    image.mimeType,
  );
  const name = alt || image.name;
  if (failed)
    return (
      <UnavailableHostImage
        alt={alt}
        reason="Station could not send its stored copy."
      />
    );
  if (!url)
    return (
      <span
        className="markdown-image-pending"
        role="status"
        aria-label={`Loading ${name}`}
      />
    );
  return (
    <PreviewButton name={name} url={url} mediaType={image.mimeType}>
      <img src={url} alt={alt ?? ''} className="markdown-image" />
    </PreviewButton>
  );
}

function UnavailableHostImage({
  alt,
  reason,
}: {
  alt: string | undefined;
  reason: string;
}) {
  return (
    <span className="markdown-image-unavailable" role="note">
      <WarningGlyph aria-hidden="true" />
      <span>
        {alt ? <strong>{alt}</strong> : null}
        {alt ? ' — ' : null}
        Image not available on this device: {reason}
      </span>
    </span>
  );
}
