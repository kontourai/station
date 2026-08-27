import DOMPurify from 'dompurify';

/**
 * Renders host-produced HTML after sanitizing it.
 *
 * This is the only first-paint-reachable DOMPurify consumer, and DOMPurify is
 * ~118 KB of source — so this module is imported lazily (see
 * `EphemeralMessage`). Every producer of `contentType: 'html'` ephemeral
 * messages is a slash command that already awaits a network round trip before
 * emitting, so the sanitizer download overlaps work the user is already
 * waiting on.
 *
 * The write-once ref callback is carried over verbatim from `EphemeralMessage`:
 * ephemeral content is fixed at creation, and the guard keeps a re-render from
 * re-writing the subtree.
 */
export function SanitizedHtml({ html }: { html: string }) {
  return (
    <div
      ref={(el) => {
        if (el && !el.dataset.initialized) {
          el.innerHTML = DOMPurify.sanitize(html);
          el.dataset.initialized = 'true';
        }
      }}
    />
  );
}
