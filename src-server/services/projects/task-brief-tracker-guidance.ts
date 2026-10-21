/**
 * The tracker guidance a Task brief carries when its Task has a linked work
 * item (epic #4003). Station has no channel for shipping a built-in skill,
 * and Codex has no skill channel at all, so the guidance travels inside the
 * brief instead.
 *
 * Source: the body of the `tracker-hygiene` SKILL.md drafted for this epic,
 * frontmatter and top-level title dropped, its level-2 headings demoted one
 * level so they nest under the brief's own "## Tracker guidance" heading.
 * A TypeScript constant, not a runtime file read: `.md` files are not
 * bundled into the server build.
 */
export const TRACKER_GUIDANCE = `The tracker item is what the team committed to. People read it without opening
Station. The Station Task holds the full execution memory. Keep the two
separate: the tracker gets a short, human-readable note at milestones; the
Task gets the detail.

### Where things go

- Execution detail goes to the Task memory: rewrite the Task summary with
  \`task_summary_update\`, and record decisions, open questions and dead
  ends with \`task_record\`.
- To catch up on what other Sessions did, call \`get_task_brief\`.
- A short progress note for people goes on the tracker item, only at a
  milestone.

### When to comment on the tracker item

Comment at milestones only:

- a slice of the work is done
- you are blocked
- a decision was made that people need to see
- a pull request was opened

Never comment per commit, per step, or to say you started.

### Comment format

Write for a person skimming the issue. Plain prose and short bullets. Include
only the parts that apply:

- **Progress:** what is now done, in outcome terms.
- **Remaining:** what is left.
- **Decisions:** what was chosen and why, in a sentence.
- **Open questions:** each addressed to a named person (\`@name\`).
- **PR:** the pull request link, when one exists.

Leave out commit SHAs unless someone asked for them. Keep it under about ten
lines.

Post with the host's \`gh\` CLI, passing the body on stdin so quoting stays safe:

\`\`\`bash
gh issue comment <n> --repo owner/name --body-file - <<'EOF'
Progress: ...
Remaining: ...
PR: https://github.com/owner/name/pull/<m>
EOF
\`\`\`

To read the item and its recent comments first:

\`\`\`bash
gh issue view <n> --repo owner/name --comments
\`\`\`

### Linking pull requests

Put the link in the PR body, one line per item:

- \`Closes #N\` for the primary item, and for any secondary item this PR fully
  finishes.
- \`Refs #N\` for an item that is only partly addressed.

For an item in another repository use \`Closes owner/name#N\`. The merged PR
closes the item. You do not.

### Never do these

- Do not close, reopen, retitle, relabel, reassign or reprioritize a tracker
  item (\`gh issue close\`, \`gh issue edit\`, and similar).
- Do not change the Task's status. Status is a person's action.

If you think the item should change, say so in a comment or an open question
and let a person decide.

### Public repositories

Comments on a public repository are public. Never paste secrets, tokens,
private product or repository names, customer data, or local filesystem paths.
Describe the work instead of quoting logs or terminal output verbatim.`;
