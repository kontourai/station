/** Deterministic, deliberately narrow reducer for the two issue handoff labels. */
import { BACKLOG_POLICY } from './backlog-priority-policy.mjs';
import { NEEDS_MAINTAINER, NEEDS_REPORTER } from './lifecycle-labels.mjs';

// Re-exported so existing importers keep working; the names live in a leaf
// module because this file's policy import reaches label-manifest.mjs, which
// must not import back into a module still being evaluated (#1312).
export { NEEDS_MAINTAINER, NEEDS_REPORTER };
export const BUG_LABEL = 'bug';
export const BUG_PRIORITY = 'P1';
export const LIFECYCLE_LABELS = Object.freeze([
  NEEDS_MAINTAINER,
  NEEDS_REPORTER,
]);
export const MAINTAINER_PERMISSIONS = Object.freeze([
  'triage',
  'write',
  'maintain',
  'admin',
]);

function labelNames(labels = []) {
  return new Set(
    labels.map((label) => (typeof label === 'string' ? label : label.name)),
  );
}

/** Remove hidden remarks and quoted Markdown before deciding whether a reply adds content. */
export function visibleCommentText(body = '') {
  return String(body)
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .trim();
}

const ACKNOWLEDGEMENT =
  /^(?:(?:thanks?(?: again)?|thank you(?: again)?|thx|ack(?:nowledged)?|got it|sounds good|lgtm|okay|ok|understood|i understand|will do|i['’]ll do that|no problem|\+1|👍|✅|🙏|🙂|😀|😄|❤️|❤|👏|👀)[\s!.,:-]*)+$/iu;

export function isSubstantiveReply(body) {
  const visible = visibleCommentText(body);
  if (!visible || ACKNOWLEDGEMENT.test(visible)) return false;
  // Emoji-only comments never advance the issue, even when GitHub's emoji set changes.
  return /[\p{L}\p{N}]/u.test(visible);
}

/**
 * Pure policy derivation, not a judgment call: the backlog policy's owner
 * directive is "every bug is P1", so a `bug` label with no classification
 * label yet derives exactly one addition. An issue that already carries any
 * classification (a priority or a non-actionable disposition) is left alone —
 * deliberate classification stays with the filer for everything else, and the
 * backlog gate remains the backstop.
 */
function bugClassificationAdditions(labels) {
  const existing = labelNames(labels);
  if (!existing.has(BUG_LABEL)) return [];
  if (
    BACKLOG_POLICY.classificationLabels.some((label) => existing.has(label))
  ) {
    return [];
  }
  return [BUG_PRIORITY];
}

function patchFor(labels, desired) {
  const existing = labelNames(labels);
  const add = existing.has(desired) ? [] : [desired];
  const opposite =
    desired === NEEDS_MAINTAINER ? NEEDS_REPORTER : NEEDS_MAINTAINER;
  const remove = existing.has(opposite) ? [opposite] : [];
  return { add, remove };
}

/**
 * Accepts only normalized GitHub event facts. It never reads issue prose or
 * guesses intent; callers must authorize the maintainer label action first.
 */
export function reduceIssueLifecycle(input) {
  const labels = input.issue?.labels ?? [];
  if (input.kind === 'issue-opened' || input.kind === 'issue-reopened') {
    const patch = patchFor(labels, NEEDS_MAINTAINER);
    return {
      add: [...patch.add, ...bugClassificationAdditions(labels)],
      remove: patch.remove,
    };
  }
  if (
    input.kind === 'maintainer-requested-reporter' &&
    input.label === BUG_LABEL
  ) {
    // The workflow routes every `labeled` event here; a later-arriving `bug`
    // label derives P1 the same way it does at filing. No permission check:
    // GitHub already restricts labeling to triage+, and the derivation is
    // unconditional policy either way.
    return { add: bugClassificationAdditions(labels), remove: [] };
  }
  if (
    input.kind === 'maintainer-requested-reporter' &&
    input.label === NEEDS_REPORTER &&
    MAINTAINER_PERMISSIONS.includes(input.actorPermission)
  ) {
    return patchFor(labels, NEEDS_REPORTER);
  }
  if (
    input.kind === 'reporter-commented' &&
    input.actorLogin === input.reporterLogin &&
    labelNames(labels).has(NEEDS_REPORTER) &&
    isSubstantiveReply(input.commentBody)
  ) {
    return patchFor(labels, NEEDS_MAINTAINER);
  }
  return { add: [], remove: [] };
}
