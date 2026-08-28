import { describe, expect, it } from 'vitest';
import {
  knowledgeNamespaceCreateSchema,
  knowledgeNamespaceUpdateSchema,
} from '../schema-definitions/content.js';

/**
 * archive#1503 delta review, R1 — a TRIPWIRE, not a behaviour test.
 *
 * The knowledge-namespace CRUD routes write straight into
 * `project.knowledgeNamespaces` with no validation. A `repoRoot` naming a repo
 * the project does not declare makes the composed manifest UNREADABLE, which
 * fails every project seam at once — so archive#1503 refuses one on the PROJECT
 * write path, where the declared resource set is available.
 *
 * These routes are safe today ONLY because their schema is a plain `z.object`
 * (strip mode) with no `repoRoot` key, so the field never survives the parse.
 * That is an omission, not a guard, and it will stop holding the moment someone
 * makes `repoRoot` editable here — which the feature eventually needs.
 *
 * When that happens, this test fails and says what else has to change. A guard
 * pre-installed in those handlers instead would have a rejection path that
 * cannot execute, which is the unprovable-guardrail class the delivery protocol
 * §6 names.
 */
describe('knowledge namespace schemas do not (yet) accept a repo anchor', () => {
  const namespace = {
    id: 'api-docs',
    label: 'API docs',
    behavior: 'rag',
    repoRoot: { repoId: 'github.com/acme/api', path: 'docs' },
  };

  it.each([
    ['create', knowledgeNamespaceCreateSchema],
    ['update', knowledgeNamespaceUpdateSchema],
  ])('the %s schema strips `repoRoot`', (_label, schema) => {
    const parsed = schema.parse(namespace);

    expect('repoRoot' in parsed).toBe(false);
  });

  it('DOCUMENTS what must change when that stops being true', () => {
    // If this assertion is what failed, you are adding `repoRoot` to the
    // knowledge-namespace routes. Before you do:
    //
    //   1. Route `registerKnowledgeNamespace` / `updateKnowledgeNamespace`
    //      (src-server/services/knowledge/knowledge-namespaces.ts) through
    //      `knowledgeRepoRootProblem` from
    //      `@kontourai/station-contracts/knowledge` — the same authority the
    //      project write path uses, so the two cannot drift.
    //   2. The declared repo id set comes from the project's manifest RECORD;
    //      see `refuseInvalidRepoAnchors` in routes/projects/projects.ts for
    //      how it is read and why a missing record skips the id check.
    //   3. Refuse BEFORE `saveProject`, not after.
    //
    // Then delete this test.
    const parsed = knowledgeNamespaceCreateSchema.parse(namespace);

    expect(parsed).toEqual({
      id: 'api-docs',
      label: 'API docs',
      behavior: 'rag',
    });
  });
});
