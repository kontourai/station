import type { ComponentPropsWithoutRef } from 'react';
import { defaultUrlTransform, type UrlTransform } from 'react-markdown';
import { useOptionalPreview } from '../../contexts/PreviewContext';

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
 */
export const chatUrlTransform: UrlTransform = (url, key, node) => {
  if (
    key === 'src' &&
    node.tagName === 'img' &&
    INLINE_IMAGE_DATA_URL.test(url)
  )
    return url;
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

/**
 * A markdown image that opens the shared previewer (zoom, pinch) on click, so
 * an image in a reply is as inspectable as one the user attached. Outside the
 * chat shell — no previewer mounted — it stays a plain image.
 */
export function MarkdownImage({
  src,
  alt,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<'img'> & { node?: unknown }) {
  const preview = useOptionalPreview();
  const source = typeof src === 'string' ? src : undefined;
  const image = (
    <img {...props} src={source} alt={alt ?? ''} className="markdown-image" />
  );
  if (!preview || !source) return image;
  const name = alt || 'Image';
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
        preview.openPreview({
          url: source,
          mediaType: mediaTypeOf(source),
          name,
        });
      }}
    >
      {image}
    </button>
  );
}
