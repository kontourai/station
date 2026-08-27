/**
 * Inline `[[wikilink]]` parsing/merging (store-contract.md §2.3). Shared by both
 * Station-owned Kit-format adapters.
 *
 * Label sanitization (H1 fix, Wave-2 code review iteration 4 — CLASS-level fix, not
 * adapter-specific): `KitLink.label` is free-text display text rendered inline as
 * `[[target|label]]` — a single-line construct by every existing usage (there is no
 * multi-line wikilink display syntax anywhere in the Kit contract or this codebase).
 * The contract is silent on a label containing embedded line breaks, so per this
 * repo's "never silently corrupt, prefer the data-preserving option" default, an
 * embedded line break is collapsed to a single space and a warning is logged, rather
 * than the label being rejected outright or (worse) trusted verbatim. This is the
 * root-cause fix for the label-injection sentinel-corruption class: without a
 * multi-line label, `kit-obsidian-store`'s generated-section rendering
 * (`[[slug|label]]`) can never place the sentinel substring on its own physical
 * line, because the `[[`/`|`/`]]` wikilink syntax always shares the label's single
 * line. Both entry points that accept caller-supplied label text funnel through this
 * module's `sanitizeLabel`: `extractWikilinks` (the `[[target|label]]` body-embedded
 * syntax) and `appendUniqueLinks` (the funnel every adapter's public `link()`/
 * `create()`/`update()`/`supersede()` path uses before persisting a `KitLink[]`), so
 * no free-text label can reach disk with an embedded line break regardless of which
 * entry point it came in through.
 */
import type { KitLink } from '@kontourai/station-contracts/knowledge-store';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger({ name: 'knowledge-store:wikilinks' });

// Matches ONLY if `label` contains at least one line-break character — used as a
// stateless pre-check so the common (no line break) case never pays for a `.replace`
// call or a log lookup. No `g`/`y` flag, so repeated `.test()` calls are safe (no
// `lastIndex` state to leak between calls).
const LABEL_LINE_BREAK_PATTERN = /[\r\n\u2028\u2029]/;

/**
 * Collapse any embedded line break(s) in a `KitLink.label` value to a single space
 * and trim, warning when a collapse actually occurs. Returns the label unchanged
 * (same reference) when no line break is present, so callers can cheaply detect
 * "nothing changed" via reference/value equality without an extra warn/log lookup.
 * Returns `undefined` if collapsing leaves nothing but whitespace, so callers can
 * drop the `label` field entirely rather than persisting an empty string.
 */
function sanitizeLabel(label: string): string | undefined {
  if (!LABEL_LINE_BREAK_PATTERN.test(label)) return label;
  const collapsed = label.replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
  logger.warn(
    'KitLink.label contained an embedded line break; collapsed to a single-line ' +
      'value (labels are inline wikilink display text, never multi-line content — ' +
      'this also prevents a label from ever placing a structural sentinel line on ' +
      'its own physical line inside a generated section)',
    { original: label, sanitized: collapsed },
  );
  return collapsed.length > 0 ? collapsed : undefined;
}

/** Apply `sanitizeLabel` to a single `KitLink`, dropping `label` if it sanitizes away. */
function sanitizeLink(link: KitLink): KitLink {
  if (typeof link.label !== 'string') return link;
  const sanitizedLabel = sanitizeLabel(link.label);
  if (sanitizedLabel === link.label) return link;
  if (sanitizedLabel === undefined) {
    const { label: _label, ...rest } = link;
    return rest as KitLink;
  }
  return { ...link, label: sanitizedLabel };
}

/** Apply `sanitizeLabel` across an array of `KitLink`s (see module doc comment). */
export function sanitizeLinks(links: KitLink[]): KitLink[] {
  return links.map(sanitizeLink);
}

/**
 * Extract all `[[target_id]]` / `[[target_id|label]]` links from body text. The
 * label capture group (`[^\]]+`) matches embedded newlines by construction (it is
 * only excluded from matching a literal `]`), so a body containing
 * `[[target|evil\n<!-- kit:body-end -->\nafter]]` would otherwise parse `label` as
 * `'evil\n<!-- kit:body-end -->\nafter'` — sanitized here before the link is ever
 * constructed (H1 fix, Wave-2 code review iteration 4).
 */
export function extractWikilinks(body: string): KitLink[] {
  const links: KitLink[] = [];
  // One forward scan: unlike the former global regexp, malformed `[[[[...`
  // cannot retry a delimiter-free suffix for every opening bracket. Targets
  // and labels deliberately have no arbitrary size cap; both are valid Kit
  // contract content.
  let index = 0;
  let targetStart = -1;
  let labelStart = -1;
  while (index < body.length) {
    if (targetStart === -1) {
      if (body[index] === '[' && body[index + 1] === '[') {
        targetStart = index + 2;
        labelStart = -1;
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    if (body[index] === '[' && body[index + 1] === '[' && labelStart === -1) {
      // Recover from a malformed outer start without revisiting characters.
      targetStart = index + 2;
      index += 2;
      continue;
    }
    if (labelStart === -1 && body[index] === '|') {
      labelStart = index + 1;
      index += 1;
      continue;
    }
    if (body[index] === ']' && body[index + 1] === ']') {
      const target_id = body
        .slice(targetStart, labelStart === -1 ? index : labelStart - 1)
        .trim();
      const rawLabel =
        labelStart === -1 ? undefined : body.slice(labelStart, index).trim();
      if (target_id.length > 0 && (labelStart === -1 || rawLabel!.length > 0)) {
        const label = rawLabel ? sanitizeLabel(rawLabel) : undefined;
        links.push(
          label
            ? { target_id, kind: 'related', label }
            : { target_id, kind: 'related' },
        );
      }
      targetStart = -1;
      labelStart = -1;
      index += 2;
      continue;
    }
    if (body[index] === ']') {
      // A lone closing bracket cannot occur in either old capture group.
      targetStart = -1;
      labelStart = -1;
    }
    index += 1;
  }
  return links;
}

/** Stable de-dup key for a `KitLink`/reverse-edge tuple: `(target_id, kind)`. */
function linkKey(l: Pick<KitLink, 'target_id' | 'kind'>): string {
  return `${l.target_id}::${l.kind}`;
}

/**
 * Append `additions` onto `existing`, de-duplicated by `(target_id, kind)` —
 * entries already present in `existing` (by that key) are skipped, `existing`
 * entries always win on conflict. Shared by `mergeLinks` (explicit + wikilink
 * merge) and both adapters' `link()`/`supersede()` (existing + new-links append),
 * which were previously three copies of the identical pattern.
 *
 * Both `existing` and `additions` are passed through `sanitizeLinks` first (H1 fix,
 * Wave-2 code review iteration 4) — this covers every link-touching entry point
 * that flows through THIS function specifically: `create()`'s/`update()`'s
 * explicit `links` field, `link()`'s `links` argument, `supersede()`'s new-record
 * merge, and `mergeLinks`'s wikilink-derived additions. Sanitizing `existing` too
 * is intentionally idempotent/harmless: a previously-persisted, already-sanitized
 * link is returned unchanged (no re-warn).
 *
 * Narrowed claim (Wave-3 code-review fast-follow — a prior version of this
 * comment overclaimed "sanitizing here once covers every call site" for the
 * whole adapter): a mutation that never calls THIS function — a metadata-only
 * `update()` with no `fields.links`/`fields.body`, `apply()`/`reject()`/
 * `propose()`'s untouched-links spreads, or `retire()` — does NOT re-sanitize
 * already-persisted links through this path. That gap is closed instead at
 * `writeRecord()` in each adapter (`default-store.ts`/`obsidian-store.ts`),
 * which now calls `sanitizeLinks` unconditionally on every persisted write
 * regardless of which mutation constructed the record — so a legacy/
 * externally-authored record with an unsanitized label is genuinely cleaned
 * up at rest on its very next write, not merely on a link-touching one.
 */
export function appendUniqueLinks(
  existing: KitLink[],
  additions: KitLink[],
): KitLink[] {
  const sanitizedExisting = sanitizeLinks(existing);
  const sanitizedAdditions = sanitizeLinks(additions);
  const seen = new Set(sanitizedExisting.map(linkKey));
  const merged = [...sanitizedExisting];
  for (const addition of sanitizedAdditions) {
    if (!seen.has(linkKey(addition))) {
      merged.push(addition);
      seen.add(linkKey(addition));
    }
  }
  return merged;
}

/**
 * Merge explicit links with wikilink-derived links, de-duplicated by
 * `(target_id, kind)`; explicit links win on conflict.
 */
export function mergeLinks(
  explicit: KitLink[],
  wikilinks: KitLink[],
): KitLink[] {
  return appendUniqueLinks(explicit, wikilinks);
}
