import { writeFileSync } from 'node:fs';
import { generateServerReleaseNotes } from './lib/desktop-release-notes.mjs';

const [tag, source, output, instructions] = process.argv.slice(2);
if (!output || !instructions)
  throw new Error(
    'Usage: server-release-notes.mjs <tag> <source-sha> <output> <install-instructions>',
  );
const notes = await generateServerReleaseNotes({
  tag,
  source,
  repository: process.env.GITHUB_REPOSITORY,
  token: process.env.GH_TOKEN,
});
writeFileSync(output, `${notes}\n\n## Installation\n\n${instructions}\n`);
