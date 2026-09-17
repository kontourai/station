/**
 * Where a Layout lives on disk, by owner (#2060; design record
 * `docs/design/shell-ownership-and-boards.md`, decision D1).
 *
 * Under the Station home:
 *
 * ```text
 * projects/<project-slug>/layouts/<layout-slug>.json   project-owned (unchanged)
 * layouts/personal/<principal-key>/<layout-slug>.json  principal-owned (a Board)
 * layouts/instance/<layout-slug>.json                  instance-owned
 * ```
 *
 * A principal- or instance-owned Layout is deliberately NOT under
 * `projects/`: `listLayouts(projectSlug)` reads exactly one project's
 * `layouts` directory, so a Board cannot appear in a project's layout route
 * by construction rather than by a filter somebody has to remember to apply.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  InvalidLayoutOwnerError,
  type LayoutConfig,
  type LayoutOwner,
  layoutOwner,
} from '@kontourai/station-contracts/layout';
import {
  isPrincipalRef,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import { PATH_SEGMENT_PATTERN } from '../knowledge-index/path-safety.js';

/** How much of the readable prefix a principal directory name keeps. */
const PRINCIPAL_KEY_LABEL_MAX = 48;
/** Hex characters of the SHA-256 digest that makes the key unambiguous. */
const PRINCIPAL_KEY_DIGEST_LENGTH = 16;

/**
 * A filesystem-safe directory name for a principal.
 *
 * A `PrincipalRef.id` is `human:<provider>:<subject>` (and the subject is not
 * constrained to path-safe characters — `:` and `/` both occur), so it cannot
 * be a path segment as written. The key is therefore a lowercased readable
 * excerpt plus a digest of the EXACT id:
 *
 * - the excerpt is for an operator reading the directory listing; it is lossy
 *   on purpose and nothing is ever derived from it;
 * - the digest is what makes the key an identity. Lowercasing the excerpt
 *   would otherwise collide two principals differing only in case on a
 *   case-insensitive filesystem (macOS, the primary dogfood platform), and
 *   the digest — of the unmodified id, in lowercase hex — is immune to that
 *   folding.
 *
 * `display` never participates: it is cosmetic and explicitly must not key a
 * store (`packages/contracts/src/principal.ts`).
 *
 * The principal is validated with `isPrincipalRef` before anything is derived
 * from it: this function turns a caller-supplied value into a filesystem path
 * and into error text, so an unvalidated one reached both (#2060 review
 * LOW-5, where a NUL-carrying id was accepted and echoed back).
 */
export function principalLayoutStorageKey(principal: PrincipalRef): string {
  if (!isPrincipalRef(principal)) {
    throw new InvalidLayoutOwnerError(
      'a principal owner must carry a well-formed PrincipalRef',
    );
  }
  const id = principal.id;
  const digest = createHash('sha256')
    .update(id, 'utf8')
    .digest('hex')
    .slice(0, PRINCIPAL_KEY_DIGEST_LENGTH);
  const label = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PRINCIPAL_KEY_LABEL_MAX)
    .replace(/-+$/g, '');
  // A validated id is always `<kind>:…`, so the excerpt always begins with a
  // letter; the pattern check is the backstop that would catch that ceasing
  // to hold rather than an assumption stated in a comment.
  const key = `${label}-${digest}`;
  if (!PATH_SEGMENT_PATTERN.test(key)) {
    throw new InvalidLayoutOwnerError(
      `principal layout key ${JSON.stringify(key)} is not a safe path segment`,
    );
  }
  return key;
}

/**
 * The directory holding an owner's Layout records, relative to the Station
 * home. Project owners resolve to the existing project path, so one function
 * answers "where do this owner's layouts live" for all three owners.
 */
export function layoutOwnerDirectory(
  projectHomeDir: string,
  owner: LayoutOwner,
): string {
  switch (owner.kind) {
    case 'project':
      return join(projectHomeDir, 'projects', owner.projectSlug, 'layouts');
    case 'principal':
      return join(
        projectHomeDir,
        'layouts',
        'personal',
        principalLayoutStorageKey(owner.principal),
      );
    case 'instance':
      return join(projectHomeDir, 'layouts', 'instance');
  }
}

/**
 * The exact record a project-owned Layout persists: `projectSlug`, never
 * `owner`. A caller may legitimately hand the adapter `{kind:'project'}` —
 * `layoutOwner` accepts it — but persisting it would change the bytes of a
 * project record and, if `projectSlug` were omitted, write a record an older
 * build's schema rejects, which makes that build's whole layout listing throw
 * (#2060 review MED-3). Normalizing at the write boundary is what keeps the
 * on-disk shape a property of the store rather than of each caller.
 *
 * Key order is preserved for a record that already carries the right
 * `projectSlug`, so a re-save is byte-identical.
 */
export function normalizeProjectLayoutRecord(
  record: LayoutConfig,
  projectSlug: string,
): LayoutConfig {
  const owner = layoutOwner(record);
  if (owner.kind !== 'project' || owner.projectSlug !== projectSlug) {
    throw new InvalidLayoutOwnerError(
      `record owned by ${describeLayoutOwner(owner)} is not a layout of project '${projectSlug}'`,
    );
  }
  const { owner: _owner, ...withoutOwner } = record;
  return withoutOwner.projectSlug === projectSlug
    ? withoutOwner
    : { ...withoutOwner, projectSlug };
}

/** Whether two owners name the same owner. Cosmetic `display` is ignored. */
export function isSameLayoutOwner(a: LayoutOwner, b: LayoutOwner): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'project' && b.kind === 'project') {
    return a.projectSlug === b.projectSlug;
  }
  if (a.kind === 'principal' && b.kind === 'principal') {
    return a.principal.id === b.principal.id;
  }
  return true;
}

/** Owner text for an error message, without leaking a principal's display. */
export function describeLayoutOwner(owner: LayoutOwner): string {
  switch (owner.kind) {
    case 'project':
      return `project '${owner.projectSlug}'`;
    case 'principal':
      return `principal '${owner.principal.id}'`;
    case 'instance':
      return 'this Station instance';
  }
}
