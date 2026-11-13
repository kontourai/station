import { writeFileSync } from 'node:fs';
import { generateServerReleaseNotes } from './lib/desktop-release-notes.mjs';

const [tag, source, output, instructions] = process.argv.slice(2);
if (!output || !instructions)
  throw new Error(
    'Usage: server-release-notes.mjs <tag> <source-sha> <output> <install-instructions>',
  );
let notes;
try {
  notes = await generateServerReleaseNotes({
    tag,
    source,
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN,
  });
} catch (error) {
  // Nightly availability must not depend on GitHub note generation. Stable and
  // preview publication fail closed so reviewed releases retain their changelog.
  if (!tag.includes('-nightly.') || !error.releaseNotesUnavailable) throw error;
  console.warn(
    `::warning::Server changelog unavailable; publishing installation instructions only. ${String(error.releaseNotesReason ?? 'reason unavailable').replace(/[\r\n]/g, ' ')}`,
  );
  notes = '';
}
writeFileSync(output, `${notes}\n\n## Installation\n\n${instructions}\n`);
