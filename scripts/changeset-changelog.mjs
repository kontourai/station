/**
 * The changelog generator `changeset version` loads (.changeset/config.json).
 *
 * It is `@changesets/cli/changelog` with trailing whitespace removed from
 * every generated line. Upstream indents each continuation line of a
 * multi-paragraph note by two spaces, blank lines included, so every
 * paragraph break became `  ` in the release PR's CHANGELOG.md files and
 * `git diff --check` (scripts/diff-whitespace-gate.mjs on the PR, the merge
 * queue's `diff` job) rejected the generated output. Words, order and
 * indentation are otherwise upstream's, so the review ledger's
 * release-versioning contract (scripts/lib/release-versioning-review.mjs)
 * still traces each entry to its consumed note.
 */
import upstream from '@changesets/cli/changelog';

const withoutTrailingWhitespace = (text) =>
  text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');

const changelogFunctions = {
  getReleaseLine: async (...args) =>
    withoutTrailingWhitespace(await upstream.getReleaseLine(...args)),
  getDependencyReleaseLine: async (...args) =>
    withoutTrailingWhitespace(await upstream.getDependencyReleaseLine(...args)),
};

export default changelogFunctions;
