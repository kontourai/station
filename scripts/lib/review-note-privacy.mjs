import { createHash } from 'node:crypto';
import { PRIVACY_PATTERNS } from '../public-docs-hygiene.mjs';

// A redaction changes only recognized private-host text in human prose.
// Review identity, inputs, claims outside that text, and timestamps stay exact.
export function redactReviewNoteHosts(file, text) {
  const recognized = PRIVACY_PATTERNS.find(
    ([code]) => code === 'private-hostname',
  )[1];
  const pattern = new RegExp(recognized.source, recognized.flags);
  const redacted = text.replace(
    /"note":("(?:[^"\\]|\\.)*")/g,
    (_field, value) => {
      const note = JSON.parse(value).replace(pattern, (host) =>
        /^localhost$/i.test(host) ? host : '[private host]',
      );
      return `"note":${JSON.stringify(note)}`;
    },
  );
  if (redacted === text) return null;
  const digest = createHash('sha256')
    .update(redacted)
    .digest('hex')
    .slice(0, 12);
  return {
    file: file.replace(/[a-f0-9]{12}\.json$/, `${digest}.json`),
    text: redacted,
  };
}
