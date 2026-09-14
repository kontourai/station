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
import type { LayoutOwner } from '@kontourai/station-contracts/layout';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
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
 */
export function principalLayoutStorageKey(principal: PrincipalRef): string {
  const id = principal.id;
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new TypeError(
      'principal layout key requires a non-empty principal id',
    );
  }
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
  // An id whose characters are all replaced leaves nothing to read; the key
  // must still start with an alphanumeric to be a safe path segment.
  const key = label.length > 0 ? `${label}-${digest}` : `principal-${digest}`;
  if (!PATH_SEGMENT_PATTERN.test(key)) {
    throw new TypeError(
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
