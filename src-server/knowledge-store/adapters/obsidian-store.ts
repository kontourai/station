/**
 * `kit-obsidian-store` — Station-owned adapter implementing the Knowledge Kit's
 * published store contract (store-contract.md §8/§9 baseline + Addendum A.5/A.6
 * `supersede`, Addendum B.4/B.5 `retire`, Addendum C.3 `person` routing, Addendum H
 * identity resolution) with an Obsidian-vault-shaped on-disk layout instead of the
 * `kit-default-store` adapter's flat `records/<id>.md` layout. Same
 * `KnowledgeStoreAdapter` contract, same behavioral guarantees — different physical
 * shape, so a human can browse the store as a normal Obsidian vault.
 *
 * This is a from-scratch, file-format-conformant implementation — it never imports
 * `@kontourai/flow-agents` Kit internals (ADR-0001; confirmed via grep, matching
 * `kit-default-store`'s evidence). The layout below mirrors the shape documented by
 * the Kit's own published `adapters/obsidian-store` README + Addendum C.3 and the
 * behavior of the Kit's own reference implementation (v3.3.0, read for grounding —
 * never imported — from the sibling `../flow-agents` dev tree during this session,
 * the same cross-repo-compat grounding practice Wave 1 used for `kit-default-store`):
 *
 *   <storeRoot>/
 *     people/<title-slug>.md                    person records (any category — C.3)
 *     <category-as-path>/<title-slug>.md         concept, snapshot
 *     <category-as-path>/<sourcesDir>/<slug>.md  raw, compiled (sourcesDir default "sources")
 *     archive/<original-relative-path>           superseded records (moved, not deleted — A.5)
 *     graph-index.json                           link graph (§5.1 — required)
 *     path-index.json                            id -> {path, archived} (Station-owned bookkeeping;
 *                                                 store-contract.md does not mandate an internal
 *                                                 index filename for a non-default adapter — this
 *                                                 is named differently from the Kit's own reference
 *                                                 adapter's `.graph-index.json` for clarity, since
 *                                                 that name collides visually with the *link* graph
 *                                                 index this adapter also maintains)
 *     alias-index.json                           slug alias map (Addendum H.5)
 *
 * Frontmatter carries every contract field EXCEPT `body`; the body is rendered as
 * human-readable Obsidian markdown below the frontmatter fence, delimited from any
 * generated Sources/People/Related sections by an invisible sentinel
 * (`<!-- kit:body-end -->`, never rendered by Obsidian since it is an HTML comment) so
 * body text may freely contain any markdown — including `## heading` lines — without
 * corrupting the render/parse inverse. `raw` records additionally wrap the body in a
 * collapsed callout (`> [!note]- Raw Notes`) for readability; the sentinel still marks
 * the exact boundary so the wrapper is losslessly stripped back on read.
 *
 * Sentinel-collision handling (H1 fix, Wave-2 code review): the default sentinel is
 * used whenever the rendered body text does NOT already contain that literal
 * substring. If it does — one occurrence, several occurrences, or even a body that
 * contains what looks like a *previously lengthened* sentinel — a fresh, per-write
 * sentinel is derived by `chooseBodySentinel()` below and the exact string used is
 * recorded verbatim in frontmatter (`_body_sentinel`, an underscore-prefixed key any
 * OKF/Kit consumer tolerates and ignores per the unknown-key preservation contract) so
 * `parseBodyFromRendered` never has to guess on read — it looks the key up. See that
 * function's own doc comment for the correctness argument (a length-pigeonhole proof,
 * not a probabilistic one).
 *
 * `_body_sentinel` is a RESERVED adapter-owned key (M1 fix, Wave-2 code review iteration
 * 2): `readRecord` strips it before returning a `KitRecord` — it is bookkeeping, not
 * record data, so it never leaks onto `get()`/`listByType()`/`listByCategory()` results
 * (mirroring the destructuring `writeRecord` already does on the write side). If a
 * user's own frontmatter coincidentally carries a `_body_sentinel` key whose value does
 * not look adapter-generated (see `SENTINEL_SHAPE_PATTERN`), `readRecord` treats that as
 * malformed rather than trusting it as a delimiter: it logs a warning and falls back to
 * the default sentinel under the same last-occurrence resolution described below, so a
 * coincidental foreign key can never crash a read or silently corrupt an unrelated
 * body.
 *
 * External-edit read semantics (M2 fix, Wave-2 code review iteration 2): this adapter's
 * own header above invites a human to "browse the store as a normal Obsidian vault," so
 * the read path must stay well-defined even when a file was touched outside Station.
 * `renderObsidianBody` always appends the chosen sentinel, on its own line, as the LAST
 * thing derived from the body — any generated Sources/People/Related sections are
 * appended strictly after it — so `parseBodyFromRendered` anchors to the LAST line-exact
 * occurrence of the sentinel in the file (`findLastSentinelLineIndex`), not the first
 * substring occurrence. That single change resolves all of the reachable external-edit
 * cases:
 *   - A human pastes a bare copy of the sentinel INTO the body, without touching
 *     frontmatter: the pasted line is never the last one (the adapter's own trailing
 *     sentinel still is), so the paste is inert — read back as ordinary body content.
 *   - A human deletes the trailing sentinel line entirely: no line-exact match remains,
 *     so the parser reads to EOF (no truncation), logs a warning, and the next
 *     Station-driven write self-heals by recomputing and re-appending a fresh sentinel.
 *   - A human types/pastes content AFTER the real sentinel line (the adapter's own
 *     generated-sections area): content that isn't one of the four recognized generated
 *     section headings (`## Sources` / `## Appears In` / `## People` / `## Related`) —
 *     OR that matches one of those headings by text but Station would NOT actually
 *     generate that section for this record's current links (M1 fix, Wave-2 code
 *     review iteration 4 — see `generatedSectionHeadingAvailability` below) — is
 *     merged back into the body on read (data-preserving choice) with a warning, since
 *     it would otherwise be silently discarded the next time Station regenerates those
 *     sections from `graph-index.json`. A heading matching known text alone is never
 *     sufficient proof of adapter authorship: only a record whose links actually
 *     contain the corresponding kind could ever have had that section generated by
 *     Station, so anything else under a recognized heading is hand-authored content
 *     that merely looks like adapter output — treated the same as any other
 *     unrecognized trailing content, never discarded silently.
 *
 * Named residual limitation (accepted, narrow): last-occurrence anchoring is defeated
 * only by a COMPOUND, adversarial EXTERNAL edit — deleting the real trailing sentinel
 * line AND, in the same out-of-band edit, pasting a look-alike sentinel on its own line
 * elsewhere in the body — since with the real sentinel gone, the pasted one becomes the
 * (only) last line-exact match. Each half of that compound edit is independently
 * handled correctly (see the two cases above); this is a distinct, much narrower gap
 * than the original H1/pre-fix bug (which triggered on a single ordinary paste), and is
 * called out here per the same "document accepted gaps rather than silently omitting
 * them" practice as the out-of-band filesystem-watching gap already accepted for K2
 * (`s200-knowledge-store--plan.md`).
 *
 * Label-injection sentinel corruption (H1 fix, Wave-2 code review iteration 4) —
 * CLASS-level fix, not more anchor cleverness: iteration 3 found that last-occurrence
 * anchoring's premise ("generated sections never contain a line-exact sentinel") was
 * false, because `KitLink.label` is unvalidated free text rendered verbatim into
 * generated sections, and an embedded newline (reachable via the public `link()` API or
 * via `[[target|label]]` wikilink parsing, whose label capture group matches newlines)
 * could place the literal sentinel text on its own physical line AFTER the real
 * sentinel — defeating the anchor through pure, in-process API usage, no external edit
 * required. Fixed at the class level, at the render/write boundary, in two layers:
 *   (a) Root cause — `../shared/wikilinks.ts`'s `sanitizeLinks`/`sanitizeLabel`
 *       collapse any embedded line break in a `KitLink.label` to a single space (with a
 *       warning) at the single funnel every adapter's `create()`/`update()`/`link()`/
 *       `supersede()` path already uses (`appendUniqueLinks`/`mergeLinks`) before a
 *       `KitLink[]` is ever persisted or rendered — chosen over outright rejection
 *       because a label is inherently single-line display text (every existing usage
 *       renders it inline as `[[target|label]]`; there is no multi-line wikilink
 *       display syntax anywhere in the Kit contract), so normalizing is the
 *       data-preserving option and the contract is silent on the newline case, not a
 *       rejection-worthy violation of an explicit rule.
 *   (b) Defense-in-depth — `renderObsidianBody` additionally neutralizes (backtick-wraps)
 *       any FULL line inside a generated Sources/Appears-In/People/Related section that
 *       matches `SENTINEL_SHAPE_PATTERN` (see `neutralizeSentinelShapedLines` below),
 *       regardless of which field produced it. This is a structural class guard, not a
 *       label-specific patch: it protects against ANY future free-text field that might
 *       one day be rendered into a generated section (not just `label`), and against
 *       pre-fix/externally-authored records that already carry an unsanitized label on
 *       disk (sanitization at the write boundary cannot retroactively clean bytes a
 *       human or another tool wrote directly).
 *   (c) Last-occurrence anchoring is KEPT, not replaced — with (a)+(b) in place, no
 *       free-text field this adapter renders can ever again produce a spurious
 *       line-exact sentinel match below the real one, which was the only thing that
 *       made the "anchor to the LAST match" strategy unsafe. The named residual
 *       limitation above (a compound, purely-external, deliberately-adversarial paste)
 *       is unrelated to (and not enlarged by) this fix, and last-occurrence anchoring
 *       remains the simplest correct strategy for the genuinely out-of-band-edit cases
 *       it was designed for (mid-body sentinel paste inert, deleted sentinel handled via
 *       EOF fallback + warn) — there is no remaining reason to add a second anchor
 *       strategy or multi-candidate scanning.
 *
 * Contract version: written against `store-contract.md` as of `@kontourai/flow-agents`
 * **3.3.0** — see `kit-default-store`'s header comment and #218 for the tracked sidecar
 * pin upgrade; this adapter imports nothing from the package either.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type {
  ApplyEvidence,
  CreateInput,
  KitLink,
  KitRecord,
  KitRecordType,
  KitReverseLink,
  KnowledgeAdapterDescriptor,
  KnowledgeStoreAdapter,
  LinkEvidence,
  ProposeEvidence,
  RejectEvidence,
  RetireEvidence,
  SupersedeEvidence,
  UpdateEvidence,
  UpdateFields,
} from '@kontourai/station-contracts/knowledge-store';
import { createLogger } from '../../utils/logger.js';
import {
  KnowledgeRecordNotFoundError,
  KnowledgeStoreCorruptionError,
  MissingEvidenceError,
} from '../errors.js';
import { isValidCategory } from './shared/category.js';
import { KnowledgeFileTransactions } from './shared/file-transactions.js';
import { freshnessPatch } from './shared/freshness.js';
import { parseMarkdown, serializeMarkdown } from './shared/frontmatter.js';
import {
  addLinksToGraph,
  assertGraphIndex,
  canonicalGraph,
  emptyGraph,
  type GraphIndex,
  type ReindexResult,
  removeLinksFromGraph,
} from './shared/graph-index.js';
import {
  type AliasIndex,
  assertAliasIndex,
  emptyAliasIndex,
  normalizeAliases,
  registerAliases,
  resolveRecordId,
} from './shared/identity.js';
import {
  assertKitRecord,
  VALID_STATUS_TRANSITIONS,
  VALID_TYPES,
} from './shared/record-schema.js';
import {
  appendUniqueLinks,
  extractWikilinks,
  mergeLinks,
  sanitizeLinks,
} from './shared/wikilinks.js';

const logger = createLogger({ name: 'knowledge-store:kit-obsidian-store' });

export type { ReindexResult };

// Invisible sentinel emitted between the body and any generated structural sections
// (Sources/People/Related) in every rendered note. Obsidian renders HTML comments as
// nothing, so vault readers never see it. On read, everything before the sentinel
// ACTUALLY used for this record (see `_body_sentinel` frontmatter key / `readRecord`)
// is the canonical body — collision-proof against user body text containing
// `## Sources`-shaped headings AND against user body text containing the sentinel
// substring itself (H1 fix; see `chooseBodySentinel` below).
const BODY_END_SENTINEL_BASE = '<!-- kit:body-end -->';
// Frontmatter key recording the ACTUAL sentinel used for a record, only ever written
// when it differs from `BODY_END_SENTINEL_BASE`. Underscore-prefixed so it reads
// unambiguously as adapter-owned bookkeeping rather than a Kit contract field — the
// unknown-frontmatter-key preservation guarantee (OKF v0.1 tolerance; see
// contract-suite.ts) means any other conformant reader that doesn't know this key
// simply ignores it, exactly like any other foreign frontmatter field.
const BODY_SENTINEL_FRONTMATTER_KEY = '_body_sentinel';
// Shape a `_body_sentinel` frontmatter value must match to be trusted as an
// adapter-generated delimiter (either the bare default, or the filler-based lengthened
// form `chooseBodySentinel` can produce). Guards against a user's own, unrelated
// `_body_sentinel` key (M1 edge case, Wave-2 code review iteration 2): a value that
// does not match this shape is treated as malformed rather than authoritative.
const SENTINEL_SHAPE_PATTERN = /^<!-- kit:body-end(?::x+)? -->$/;
// The exact set of generated-section headings `renderObsidianBody` can append after the
// sentinel line. Anything else found after the sentinel on read is human-authored
// content, not adapter output, and is merged back into the body rather than discarded
// (M2 fix, Wave-2 code review iteration 2 — see `extractUnrecognizedTrailingContent`).
const KNOWN_TRAILING_SECTION_PREFIXES = [
  '## Sources',
  '## Appears In',
  '## People',
  '## Related',
];
const RAW_CALLOUT_HEADER = '> [!note]- Raw Notes';

/**
 * Choose the exact sentinel string to delimit a record's body from any generated
 * structural sections that follow it in the rendered note.
 *
 * Correctness argument (deterministic, not probabilistic — no loop, no randomness):
 * - If `renderedBodyPart` (the fully-rendered body text, including the raw-callout
 *   `"> "` quoting for `raw` records) does not contain the literal substring
 *   `BODY_END_SENTINEL_BASE`, that default sentinel is used verbatim (the common case
 *   — matches every existing on-disk record, so this is a purely additive change).
 * - Otherwise, a fresh sentinel is built by interposing a run of filler characters
 *   (`'x'.repeat(renderedBodyPart.length + 1)`) between a distinguishing prefix and
 *   suffix. The resulting candidate's length is, by construction, STRICTLY GREATER
 *   than `renderedBodyPart.length`. A string can never contain a substring longer
 *   than itself, so this candidate is *provably* absent from `renderedBodyPart` —
 *   this holds for every possible input, including the adversarial "recursion" case
 *   where `renderedBodyPart` itself contains text shaped exactly like a sentinel this
 *   same function could produce for some OTHER (shorter) body: any such embedded
 *   lengthened-looking marker is, definitionally, shorter than `renderedBodyPart`,
 *   while our chosen candidate is always longer than the WHOLE of `renderedBodyPart`.
 *   No search/retry loop is needed and none can be required — the length argument
 *   alone is dispositive, which is what makes this the simpler of the two schemes
 *   considered (the alternative, escape-on-write/unescape-on-read, requires a
 *   separate, harder proof that escaping is its own exact inverse under nested/
 *   repeated escape sequences; the length-based MIME-boundary-style scheme sidesteps
 *   that class of bug entirely).
 */
function chooseBodySentinel(renderedBodyPart: string): string {
  if (!renderedBodyPart.includes(BODY_END_SENTINEL_BASE)) {
    return BODY_END_SENTINEL_BASE;
  }
  const filler = 'x'.repeat(renderedBodyPart.length + 1);
  return `<!-- kit:body-end:${filler} -->`;
}

/**
 * Defense-in-depth against the label-injection sentinel-corruption class (H1 fix,
 * Wave-2 code review iteration 4 — see the header comment's "(b)" bullet). Scans
 * `text` (a single generated section's rendered content, e.g. the `## Related`
 * block) line by line and neutralizes — by wrapping in backticks, which turns an
 * would-be HTML-comment sentinel line into inline code text instead — any line that
 * is a full, line-exact match for `SENTINEL_SHAPE_PATTERN` (i.e. any shape
 * `chooseBodySentinel` could ever produce). This is a structural guard, not a
 * label-specific patch: it fires regardless of which field produced the offending
 * line, so it also protects a pre-fix/externally-authored record whose on-disk
 * `label` was never sanitized (root-cause fix (a) only cleans labels going through
 * a Station-driven write; it cannot retroactively clean bytes already on disk).
 * Should never fire in ordinary operation now that (a) sanitizes every label at the
 * write boundary — a warning is logged if it ever does, since that means some other
 * free-text field independently reproduced the same shape.
 */
function neutralizeSentinelShapedLines(
  text: string,
  context: { id: string; section: string },
): string {
  return text
    .split('\n')
    .map((line) => {
      if (!SENTINEL_SHAPE_PATTERN.test(line)) return line;
      logger.warn(
        'a rendered line inside a generated section coincidentally matched this ' +
          "adapter's sentinel shape (SENTINEL_SHAPE_PATTERN); wrapping it in " +
          'backticks so it can never be mistaken for the real structural body/' +
          'sentinel boundary on read (defense-in-depth, H1 fix, Wave-2 code review ' +
          'iteration 4)',
        { id: context.id, section: context.section, line },
      );
      return `\`${line}\``;
    })
    .join('\n');
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the character offset where the LAST occurrence of `sentinel`, appearing as an
 * entire line by itself (not merely as a substring somewhere inside a longer line),
 * starts within `renderedText`. Returns -1 if no such line-exact occurrence exists.
 *
 * Anchoring to the LAST line-exact match (rather than the FIRST substring match,
 * `String.prototype.indexOf`'s behavior) is what makes a human-pasted copy of the
 * sentinel inside the body inert (M2 fix, Wave-2 code review iteration 2):
 * `renderObsidianBody` always writes the real, chosen sentinel as its own line
 * immediately after the complete, unmodified body text — any generated Sources/People/
 * Related sections come strictly AFTER it — so the real sentinel line is always the
 * physically LAST line-exact match in a file this adapter wrote or subsequently
 * rewrote, regardless of what a human pastes earlier in the body. A bare substring
 * match embedded mid-line (e.g. inside a sentence) never matches at all here, which is
 * an intentional, additional safety margin beyond the H1 write-side pigeonhole scheme.
 */
function findLastSentinelLineIndex(
  renderedText: string,
  sentinel: string,
): number {
  const pattern = new RegExp(
    `(?:^|\\n)(${escapeForRegExp(sentinel)})(?=\\n|$)`,
    'g',
  );
  let lastIndex = -1;
  let match: RegExpExecArray | null = pattern.exec(renderedText);
  while (match !== null) {
    lastIndex = match.index + (match[0].length - match[1].length);
    match = pattern.exec(renderedText);
  }
  return lastIndex;
}

interface SectionLinkGroups {
  sourceLinks: KitLink[];
  appearsInLinks: KitLink[];
  peopleLinks: KitLink[];
  relatedLinks: KitLink[];
}

/**
 * Partition a record's `links` by the generated-section kind they feed
 * (`renderObsidianBody` and `generatedSectionHeadingAvailability` both call this, so
 * the two can never drift apart on what counts as "this record has a Sources/
 * Appears-In/People/Related section" — a shared single source of truth rather than
 * two independently-maintained copies of the same filter logic).
 */
function partitionLinksForGeneratedSections(
  links: KitLink[] | undefined,
): SectionLinkGroups {
  const list = Array.isArray(links) ? links : [];
  return {
    sourceLinks: list.filter((l) => l.kind === 'source'),
    appearsInLinks: list.filter((l) => l.kind === 'appears-in'),
    peopleLinks: list.filter((l) => l.kind === 'person'),
    relatedLinks: list.filter(
      (l) => l.kind === 'related' || l.kind === 'refines',
    ),
  };
}

/**
 * For a given record (type + links), determine which of the four
 * `KNOWN_TRAILING_SECTION_PREFIXES` headings Station would ACTUALLY generate for it
 * right now — i.e. the exact conditions `renderObsidianBody` below uses to decide
 * whether to emit each section. Used by `extractUnrecognizedTrailingContent` (M1 fix,
 * Wave-2 code review iteration 4) so that heading TEXT alone is never treated as
 * proof of adapter authorship: a chunk that merely starts with `## Sources` but whose
 * record carries no `source`-kind link could never have been generated by Station,
 * so it must be hand-authored content that happens to share a heading name.
 */
function generatedSectionHeadingAvailability(
  type: KitRecordType,
  links: KitLink[] | undefined,
): Record<string, boolean> {
  const { sourceLinks, appearsInLinks, peopleLinks, relatedLinks } =
    partitionLinksForGeneratedSections(links);
  return {
    '## Sources': sourceLinks.length > 0,
    '## Appears In': type === 'person' && appearsInLinks.length > 0,
    '## People': peopleLinks.length > 0,
    '## Related': relatedLinks.length > 0,
  };
}

/**
 * `renderObsidianBody` follows the sentinel line with either nothing, or one or more of
 * exactly the four `KNOWN_TRAILING_SECTION_PREFIXES` sections, each starting with its
 * heading verbatim and separated by a blank line — safe to discard on read ONLY when
 * Station would actually generate that specific section for this record's current
 * links (`availability`, from `generatedSectionHeadingAvailability`), because such
 * content is recomputed from `graph-index.json` on every Station-driven write, never
 * hand-authored data. A chunk whose heading text matches one of the four prefixes but
 * whose corresponding `availability` entry is `false` is NOT safe to discard — Station
 * could never have generated it for this record, so it must be hand-authored content
 * that merely looks like adapter output (M1 fix, Wave-2 code review iteration 4: never
 * discard silently — this case now logs a warning, matching every other lossy branch
 * in this read path). Anything else found after the sentinel — a human directly
 * editing the file below the delimiter, per this adapter's own "browse as a normal
 * Obsidian vault" invitation — is NOT a recognized-and-available shape and would
 * otherwise be silently discarded the next time Station rewrites the file. Returns
 * the unrecognized remainder (trimmed), or `''` if the trailing content is empty or
 * fully accounted for by sections Station would actually generate.
 */
function extractUnrecognizedTrailingContent(
  trailing: string,
  id: string,
  availability: Record<string, boolean>,
): string {
  const trimmed = trailing.replace(/^\n+/, '');
  if (!trimmed.trim()) return '';
  const chunks = trimmed.split(/\n\n(?=## )/);
  const unrecognized: string[] = [];
  for (const chunk of chunks) {
    const matchedPrefix = KNOWN_TRAILING_SECTION_PREFIXES.find((prefix) =>
      chunk.startsWith(prefix),
    );
    if (matchedPrefix && availability[matchedPrefix]) {
      // Station would generate this exact section for this record's current links —
      // safe to discard silently, recomputed from graph-index.json on every
      // Station-driven write, never hand-authored data.
      continue;
    }
    if (matchedPrefix) {
      // Heading TEXT matches a generated-section heading, but Station would NOT
      // actually generate that section for this record (no links of the
      // corresponding kind right now) — treat as hand-authored content that merely
      // looks like adapter output; never discard silently (M1 fix, Wave-2 code
      // review iteration 4).
      logger.warn(
        'record has a hand-authored heading matching a generated-section prefix, ' +
          'but Station would not generate that section for this record right now ' +
          '(no matching links) — preserving it into the body instead of discarding',
        { id, heading: matchedPrefix },
      );
    }
    unrecognized.push(chunk);
  }
  return unrecognized.join('\n\n').trimEnd();
}

interface PathIndexEntry {
  path: string;
  archived: boolean;
}

interface PathIndex {
  by_id: Record<string, PathIndexEntry>;
  by_path: Record<string, string>;
}

function emptyPathIndex(): PathIndex {
  return { by_id: {}, by_path: {} };
}

function assertPathIndex(value: unknown, source: string): PathIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source}: path index must be an object`);
  }
  const index = value as Partial<PathIndex>;
  if (
    !index.by_id ||
    typeof index.by_id !== 'object' ||
    Array.isArray(index.by_id) ||
    !index.by_path ||
    typeof index.by_path !== 'object' ||
    Array.isArray(index.by_path)
  ) {
    throw new Error(`${source}: path index has an unsupported shape`);
  }
  for (const [id, entry] of Object.entries(index.by_id)) {
    const normalized = resolve('/', entry?.path ?? '');
    if (
      !id ||
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.path !== 'string' ||
      isAbsolute(entry.path) ||
      normalized === '/' ||
      normalized.startsWith('/../') ||
      entry.path.split(/[\\/]/).includes('..') ||
      typeof entry.archived !== 'boolean' ||
      index.by_path[entry.path] !== id
    ) {
      throw new Error(`${source}: path index contains an invalid entry`);
    }
  }
  for (const [path, id] of Object.entries(index.by_path)) {
    if (!path || !id || index.by_id[id]?.path !== path) {
      throw new Error(`${source}: path index reverse mapping is inconsistent`);
    }
  }
  return index as PathIndex;
}

export interface KitObsidianStoreOptions {
  storeRoot: string;
  /** Subfolder name for raw/compiled (source-level) records under each category. Default "sources". */
  sourcesDir?: string;
}

export class KitObsidianStoreAdapter implements KnowledgeStoreAdapter {
  private readonly root: string;
  private readonly sourcesDir: string;
  private readonly graphPath: string;
  private readonly pathIndexPath: string;
  private readonly aliasPath: string;
  private readonly files: KnowledgeFileTransactions;

  constructor(options: KitObsidianStoreOptions) {
    if (!options?.storeRoot) throw new Error('storeRoot is required');
    this.root = resolve(options.storeRoot);
    this.sourcesDir = options.sourcesDir || 'sources';
    this.graphPath = join(this.root, 'graph-index.json');
    this.pathIndexPath = join(this.root, 'path-index.json');
    this.aliasPath = join(this.root, 'alias-index.json');
    mkdirSync(this.root, { recursive: true });
    this.files = new KnowledgeFileTransactions(this.root);
  }

  // ── Internal: path index (id -> {path, archived}) ─────────────────────────

  private loadPathIndex(): PathIndex {
    try {
      const raw = this.files.readText(this.pathIndexPath);
      if (raw === null) return emptyPathIndex();
      return assertPathIndex(JSON.parse(raw), this.pathIndexPath);
    } catch (error) {
      throw new KnowledgeStoreCorruptionError(
        'path-index.json is corrupt; refusing to mutate the vault',
        {
          cause: error,
        },
      );
    }
  }

  private savePathIndex(index: PathIndex): void {
    this.files.writeText(
      this.pathIndexPath,
      `${JSON.stringify(index, null, 2)}\n`,
    );
  }

  /**
   * A path-index entry is local metadata but may be tampered with — never feed an
   * indexed path to `fs`/`path` helpers without this containment check.
   */
  private resolveStorePath(relPath: string): string {
    if (typeof relPath !== 'string' || !relPath) {
      throw new Error('Invalid store path in path index');
    }
    if (isAbsolute(relPath)) {
      throw new Error(`Path index entry escapes store root: ${relPath}`);
    }
    const absPath = resolve(this.root, relPath);
    const relativeToRoot = relative(this.root, absPath);
    if (
      relativeToRoot === '..' ||
      relativeToRoot.startsWith(`..${sep}`) ||
      isAbsolute(relativeToRoot)
    ) {
      throw new Error(`Path index entry escapes store root: ${relPath}`);
    }
    return absPath;
  }

  // ── Internal: slug / path routing (Addendum C.3) ───────────────────────────

  private slugify(title: string): string {
    return (
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'untitled'
    );
  }

  /**
   * Person records land in a top-level `people/` folder regardless of category
   * (Addendum C.3 — cross-cutting entities). Insight records (concept, snapshot) live
   * at the category node root; source-level records (raw, compiled) nest one level
   * down in `sourcesDir`. Filename collisions (same slug, different id) get a numeric
   * suffix.
   */
  private computeRelPath(
    category: string,
    title: string,
    id: string,
    type: KitRecordType,
    pathIndex: PathIndex,
  ): string {
    let catDir: string;
    if (type === 'person') {
      catDir = 'people';
    } else {
      catDir = category.replace(/\./g, '/');
      if (type === 'raw' || type === 'compiled') {
        catDir = `${catDir}/${this.sourcesDir}`;
      }
    }
    const baseSlug = this.slugify(title);
    let slug = baseSlug;
    let suffix = 2;
    while (true) {
      const relPath = `${catDir}/${slug}.md`;
      const existingId = pathIndex.by_path[relPath];
      if (!existingId || existingId === id) return relPath;
      slug = `${baseSlug}-${suffix++}`;
    }
  }

  // ── Internal: record I/O ────────────────────────────────────────────────

  private getAbsPath(id: string, pathIndex: PathIndex): string | null {
    const entry = pathIndex.by_id[id];
    if (!entry) return null;
    return this.resolveStorePath(entry.path);
  }

  private readRecord(id: string, pathIndex: PathIndex): KitRecord | null {
    const absPath = this.getAbsPath(id, pathIndex);
    if (!absPath) return null;
    const text = this.files.readText(absPath);
    if (text === null) return null;
    let meta: Record<string, unknown>;
    let renderedText: string;
    try {
      ({ meta, body: renderedText } = parseMarkdown(text));
    } catch (error) {
      throw new KnowledgeStoreCorruptionError(`${absPath}: record is corrupt`, {
        cause: error,
      });
    }
    if (!meta.id) return null;

    const rawSentinelValue = meta[BODY_SENTINEL_FRONTMATTER_KEY];
    let sentinel = BODY_END_SENTINEL_BASE;
    if (typeof rawSentinelValue === 'string') {
      if (SENTINEL_SHAPE_PATTERN.test(rawSentinelValue)) {
        sentinel = rawSentinelValue;
      } else {
        // Reserved-key edge case (M1, Wave-2 code review iteration 2): a user's own,
        // unrelated `_body_sentinel` frontmatter value doesn't look adapter-generated —
        // never trust it as a delimiter (it would either crash nothing today, since
        // `indexOf`/line-matching just fail to find it, but could silently misbehave on
        // a future format change), fall back to the default sentinel under the same
        // last-occurrence resolution, and warn so the collision is visible.
        logger.warn(
          'record has a malformed _body_sentinel frontmatter value (reserved key; ' +
            'does not look adapter-generated) — falling back to the default sentinel ' +
            'and last-occurrence resolution',
          { id, path: absPath },
        );
      }
    }

    const availability = generatedSectionHeadingAvailability(
      meta.type as KitRecordType,
      meta.links as KitLink[] | undefined,
    );
    const body = this.parseBodyFromRendered(
      id,
      meta.type as KitRecordType,
      renderedText,
      sentinel,
      availability,
    );

    // Strip the bookkeeping key before returning — mirrors the destructuring
    // `writeRecord` already does on the write side, so it never leaks onto the public
    // `KitRecord` returned by `get()`/`listByType()`/`listByCategory()` (M1 fix, Wave-2
    // code review iteration 2).
    const { [BODY_SENTINEL_FRONTMATTER_KEY]: _sentinelKey, ...publicMeta } =
      meta as Record<string, unknown>;

    const record = assertKitRecord(publicMeta, body, absPath);
    if (record.id !== id) {
      throw new KnowledgeStoreCorruptionError(
        `${absPath}: record id does not match its path-index identity`,
      );
    }
    return record;
  }

  /**
   * Write a record to disk. On first write: computes the slug path and registers it
   * in the path index. On a title/category change to an ACTIVE record: moves the file
   * (old path removed, new path used) — an archived record's write always stays at its
   * archive path (supersede-not-delete never resurrects the pre-archive location).
   * Caller owns `pathIndex` persistence (`savePathIndex`) — this method mutates the
   * in-memory index but does not save it, so a caller writing multiple records in one
   * op (e.g. `supersede`) persists the index once at the end.
   */
  private writeRecord(rawRecord: KitRecord, pathIndex: PathIndex): void {
    // Unconditionally sanitize `links` on the single write path every
    // mutation funnels through — closes the gap the Wave-2 code review
    // named: label sanitization previously only happened inside
    // `appendUniqueLinks` (create/update-with-links/link/supersede's
    // new-record merge), so a metadata-only mutation (retire, a tags-only
    // update, apply/reject/propose's untouched-links spreads) would carry
    // forward an already-bad, legacy/externally-authored `KitLink.label` on
    // disk indefinitely — never actually cleaned up at rest, only ever
    // neutralized at render time by `neutralizeSentinelShapedLines` below
    // (which stays in place as defense-in-depth; this closes the
    // persistence half of the gap, ending the same warning re-firing on
    // every future write to that record). Idempotent/harmless for
    // already-sanitized links (no re-warn) per `sanitizeLinks`'s own
    // contract.
    const record: KitRecord = rawRecord.links
      ? { ...rawRecord, links: sanitizeLinks(rawRecord.links) }
      : rawRecord;

    const existingEntry = pathIndex.by_id[record.id];
    let targetRelPath: string;

    if (existingEntry?.archived) {
      targetRelPath = existingEntry.path;
    } else if (existingEntry) {
      const newRelPath = this.computeRelPath(
        record.category,
        record.title,
        record.id,
        record.type,
        pathIndex,
      );
      if (newRelPath !== existingEntry.path) {
        const oldAbs = this.resolveStorePath(existingEntry.path);
        this.files.remove(oldAbs);
        delete pathIndex.by_path[existingEntry.path];
        pathIndex.by_id[record.id] = { path: newRelPath, archived: false };
        pathIndex.by_path[newRelPath] = record.id;
        targetRelPath = newRelPath;
      } else {
        targetRelPath = existingEntry.path;
      }
    } else {
      const newRelPath = this.computeRelPath(
        record.category,
        record.title,
        record.id,
        record.type,
        pathIndex,
      );
      pathIndex.by_id[record.id] = { path: newRelPath, archived: false };
      pathIndex.by_path[newRelPath] = record.id;
      targetRelPath = newRelPath;
    }

    const {
      body: _body,
      [BODY_SENTINEL_FRONTMATTER_KEY]: _staleSentinel,
      ...frontmatterFields
    } = record as unknown as Record<string, unknown>;
    const { text: obsidianBody, sentinel } = this.renderObsidianBody(
      record,
      pathIndex,
    );
    if (sentinel !== BODY_END_SENTINEL_BASE) {
      frontmatterFields[BODY_SENTINEL_FRONTMATTER_KEY] = sentinel;
    }
    const text = serializeMarkdown(
      frontmatterFields as Record<string, unknown>,
      obsidianBody,
    );

    const absPath = this.resolveStorePath(targetRelPath);
    mkdirSync(dirname(absPath), { recursive: true });
    this.files.writeText(absPath, text);
  }

  /** Move an active record to `archive/` (supersede-not-delete invariant, A.5). */
  private archiveRecord(id: string, pathIndex: PathIndex): void {
    const entry = pathIndex.by_id[id];
    if (!entry || entry.archived) return;

    const archiveRelPath = `archive/${entry.path}`;
    const archiveAbs = this.resolveStorePath(archiveRelPath);
    mkdirSync(dirname(archiveAbs), { recursive: true });

    const currentAbs = this.resolveStorePath(entry.path);
    this.files.move(currentAbs, archiveAbs);

    delete pathIndex.by_path[entry.path];
    pathIndex.by_id[id] = { path: archiveRelPath, archived: true };
    pathIndex.by_path[archiveRelPath] = id;
  }

  // ── Internal: Obsidian body render / parse (must be an exact inverse) ─────

  private parseBodyFromRendered(
    id: string,
    type: KitRecordType,
    renderedText: string,
    sentinel: string,
    availability: Record<string, boolean>,
  ): string {
    const sentinelIdx = findLastSentinelLineIndex(renderedText, sentinel);

    let bodySection: string;
    let extra = '';
    if (sentinelIdx === -1) {
      // External-edit case: the trailing sentinel line was deleted entirely (M2 fix,
      // Wave-2 code review iteration 2). Read to EOF rather than truncating to
      // nothing/guessing, warn so the gap is visible, and rely on the next
      // Station-driven write to self-heal (writeRecord always recomputes and
      // re-appends a fresh sentinel unconditionally).
      logger.warn(
        'record body is missing its structural sentinel line (likely deleted by an ' +
          'external edit); reading to end-of-file instead of truncating; a fresh ' +
          'sentinel will be written on the next Station-driven write',
        { id, sentinel },
      );
      bodySection = renderedText;
    } else {
      bodySection = renderedText.slice(0, sentinelIdx);
      const trailing = renderedText.slice(sentinelIdx + sentinel.length);
      extra = extractUnrecognizedTrailingContent(trailing, id, availability);
      if (extra) {
        // External-edit case: content was hand-added after the real sentinel line that
        // isn't one of the recognized generated sections (M2 fix, Wave-2 code review
        // iteration 2). Data-preserving choice: merge it back into the body on read
        // rather than silently dropping it the next time Station regenerates the
        // Sources/People/Related sections from graph-index.json.
        logger.warn(
          'record has unrecognized content after its structural sentinel (likely ' +
            'added by an external edit); merging it back into the body on read so it ' +
            'is not lost on the next Station-driven write',
          { id },
        );
      }
    }

    let body: string;
    if (type === 'raw') {
      const lines = bodySection.split('\n');
      const bodyLines: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('> ')) {
          bodyLines.push(line.slice(2));
        } else if (line === '>') {
          bodyLines.push('');
        } else {
          break;
        }
      }
      body = bodyLines.join('\n');
    } else {
      body = bodySection.trimEnd();
    }

    return extra ? `${body}\n\n${extra}` : body;
  }

  private idToFilename(id: string, pathIndex: PathIndex): string {
    const entry = pathIndex.by_id[id];
    if (!entry) return id;
    return basename(this.resolveStorePath(entry.path), '.md');
  }

  private renderObsidianBody(
    record: KitRecord,
    pathIndex: PathIndex,
  ): { text: string; sentinel: string } {
    const { sourceLinks, appearsInLinks, peopleLinks, relatedLinks } =
      partitionLinksForGeneratedSections(record.links);

    const wikiLinks = (linkList: KitLink[]): string =>
      linkList
        .map((l) => {
          if (!l.target_id) return null;
          const slug = this.idToFilename(l.target_id, pathIndex);
          if (!slug) return null;
          return l.label ? `[[${slug}|${l.label}]]` : `[[${slug}]]`;
        })
        .filter((v): v is string => Boolean(v))
        .join(', ');

    // Build a generated section's text and immediately neutralize any line inside it
    // that coincidentally matches the sentinel's shape (H1 fix, Wave-2 code review
    // iteration 4, "(b)" defense-in-depth — see `neutralizeSentinelShapedLines`).
    // Root-cause fix "(a)" (`sanitizeLinks` in shared/wikilinks.ts) means a
    // Station-sanitized `label` can never by itself produce this on a fresh write —
    // this guard exists for any OTHER free-text field that might one day render into
    // a generated section, and for pre-fix/externally-authored records whose on-disk
    // `label` predates the write-side sanitization.
    const renderSection = (heading: string, linkList: KitLink[]): string =>
      neutralizeSentinelShapedLines(`${heading}\n\n${wikiLinks(linkList)}`, {
        id: record.id,
        section: heading,
      });

    let bodyPart: string;
    if (record.type === 'raw') {
      bodyPart = `${RAW_CALLOUT_HEADER}\n> ${record.body.replace(/\n/g, '\n> ')}`;
    } else {
      bodyPart = record.body;
    }

    // Collision-proof: the sentinel is chosen against the FULLY RENDERED bodyPart
    // (post raw-callout-quoting, if any) — not the raw `record.body` — so a
    // collision hiding behind the `"> "` quoting prefix is caught too (H1 fix).
    const sentinel = chooseBodySentinel(bodyPart);
    const parts = [`${bodyPart}\n${sentinel}`];

    if (sourceLinks.length > 0) {
      parts.push(renderSection('## Sources', sourceLinks));
    }
    if (record.type === 'person' && appearsInLinks.length > 0) {
      parts.push(renderSection('## Appears In', appearsInLinks));
    }
    if (peopleLinks.length > 0) {
      parts.push(renderSection('## People', peopleLinks));
    }
    if (relatedLinks.length > 0) {
      parts.push(renderSection('## Related', relatedLinks));
    }

    return { text: parts.join('\n\n'), sentinel };
  }

  /**
   * Records with `archived: true` (superseded — A.5) are intentionally excluded here:
   * they remain fully `get`/`getLinks`-able (Addendum J.3's cross-adapter supersession
   * surface), but drop out of the working-set listing surface the same way this
   * adapter physically removes them from the active vault tree. This mirrors the
   * Kit's own reference Obsidian adapter and is distinct from — and independent of —
   * the `status`-based `retired` exclusion below, which both adapters share.
   */
  private allRecords(pathIndex: PathIndex): KitRecord[] {
    const records: KitRecord[] = [];
    for (const [id, entry] of Object.entries(pathIndex.by_id)) {
      if (entry.archived) continue;
      const record = this.readRecord(id, pathIndex);
      if (record) records.push(record);
    }
    return records;
  }

  // ── Internal: graph + alias index ──────────────────────────────────────

  private loadGraph(): GraphIndex {
    const raw = this.files.readText(this.graphPath);
    if (raw === null) return emptyGraph();
    try {
      return assertGraphIndex(JSON.parse(raw), this.graphPath);
    } catch (error) {
      if (error instanceof KnowledgeStoreCorruptionError) throw error;
      throw new KnowledgeStoreCorruptionError(
        `${this.graphPath}: graph index is corrupt`,
        { cause: error },
      );
    }
  }

  private loadGraphForReindex(): GraphIndex {
    try {
      return this.loadGraph();
    } catch (error) {
      if (!(error instanceof KnowledgeStoreCorruptionError)) throw error;
      logger.warn(
        'graph-index.json is corrupt; explicit reindex will rebuild it from authoritative records',
        { path: this.graphPath, error },
      );
      return emptyGraph();
    }
  }

  private saveGraph(graph: GraphIndex): void {
    this.files.writeText(this.graphPath, `${JSON.stringify(graph, null, 2)}\n`);
  }

  private loadAliasIndex(): AliasIndex {
    const raw = this.files.readText(this.aliasPath);
    if (raw === null) return emptyAliasIndex();
    try {
      return assertAliasIndex(JSON.parse(raw), this.aliasPath);
    } catch (error) {
      if (error instanceof KnowledgeStoreCorruptionError) throw error;
      throw new KnowledgeStoreCorruptionError(
        `${this.aliasPath}: alias index is corrupt`,
        { cause: error },
      );
    }
  }

  private saveAliasIndex(index: AliasIndex): void {
    this.files.writeText(this.aliasPath, `${JSON.stringify(index, null, 2)}\n`);
  }

  private resolveId(
    input: string,
    pathIndex?: PathIndex,
    aliasIndex?: AliasIndex,
  ): string | null {
    const idx = pathIndex ?? this.loadPathIndex();
    const aliases = aliasIndex ?? this.loadAliasIndex();
    return resolveRecordId(input, {
      idExists: (rid) => Boolean(idx.by_id[rid]),
      listIds: () => Object.keys(idx.by_id),
      bySlug: aliases.by_slug,
    });
  }

  /**
   * Rebuild the link graph + alias index from every currently-ACTIVE (non-archived)
   * record's own `links`/`aliases` (§5.2, Addendum H.5). Named, accepted limitation
   * (matches the Kit's own reference Obsidian adapter's equivalent behavior): a
   * superseded record's own outbound links are not replayed by `reindex()` because
   * archived records are excluded from the scan — this is safe for the graph's
   * *reverse* `supersedes` edges (those live on the still-active superseding record),
   * but an archived record's other, unrelated outbound links would not survive a
   * from-scratch `reindex()` after `graph-index.json` is lost. Out of scope for K2;
   * flagged here for whichever future wave (K3+) needs archive-aware reindexing.
   */
  async reindex(): Promise<ReindexResult> {
    return this.files.mutate('reindex', () => this.reindexLocked());
  }

  private reindexLocked(): ReindexResult {
    const pathIndex = this.loadPathIndex();
    const records = this.allRecords(pathIndex).sort((a, b) =>
      a.id.localeCompare(b.id),
    );

    const rebuiltGraph = emptyGraph();
    for (const record of records) {
      addLinksToGraph(
        rebuiltGraph,
        record.id,
        Array.isArray(record.links) ? record.links : [],
      );
    }
    const links = Object.values(rebuiltGraph.forward).reduce(
      (n, arr) => n + arr.length,
      0,
    );
    const changed =
      canonicalGraph(this.loadGraphForReindex()) !==
      canonicalGraph(rebuiltGraph);
    this.saveGraph(rebuiltGraph);

    const rebuiltAliases = emptyAliasIndex();
    for (const record of records) {
      const slugs = normalizeAliases(record.aliases);
      if (slugs.length) registerAliases(rebuiltAliases, record.id, slugs);
    }
    this.saveAliasIndex(rebuiltAliases);

    return {
      records: records.length,
      links,
      forwardSources: Object.keys(rebuiltGraph.forward).length,
      reverseTargets: Object.keys(rebuiltGraph.reverse).length,
      changed,
    };
  }

  // ── create (§6.1) ──────────────────────────────────────────────────────

  async create(input: CreateInput): Promise<string> {
    return this.files.mutate('create', () => this.createLocked(input));
  }

  private createLocked(input: CreateInput): string {
    if (!input.type) {
      throw new MissingEvidenceError('create: missing required field: type');
    }
    if (!VALID_TYPES.has(input.type)) {
      throw new MissingEvidenceError(
        `create: type must be one of raw, compiled, concept, snapshot, person; got: ${input.type}`,
      );
    }
    if (!input.title?.trim()) {
      throw new MissingEvidenceError('create: missing required field: title');
    }
    if (typeof input.body !== 'string' || input.body.trim() === '') {
      throw new MissingEvidenceError('create: missing required field: body');
    }
    if (!input.category) {
      throw new MissingEvidenceError(
        'create: missing required field: category',
      );
    }
    if (!isValidCategory(input.category)) {
      throw new MissingEvidenceError(
        `create: invalid category: ${input.category}`,
      );
    }
    if (!input.provenance?.agent) {
      throw new MissingEvidenceError(
        'create: missing required provenance field: provenance.agent',
      );
    }

    const id = input.id || randomUUID();
    const now = new Date().toISOString();

    const aliases = normalizeAliases(input.aliases);
    let aliasIndex: AliasIndex | null = null;
    if (aliases.length) {
      aliasIndex = this.loadAliasIndex();
      registerAliases(aliasIndex, id, aliases);
    }

    const fresh = freshnessPatch(input);

    const explicitLinks = input.links ?? [];
    const wikilinks = extractWikilinks(input.body);
    const links = mergeLinks(explicitLinks, wikilinks);

    const record: KitRecord = {
      id,
      type: input.type,
      title: input.title,
      category: input.category,
      tags: input.tags ?? [],
      ...(aliases.length ? { aliases } : {}),
      status: 'active',
      created_at: now,
      updated_at: now,
      ...fresh,
      provenance: {
        agent: input.provenance.agent,
        ...(input.provenance.session_id
          ? { session_id: input.provenance.session_id }
          : {}),
        ...(input.provenance.source_ids?.length
          ? { source_ids: input.provenance.source_ids }
          : {}),
        ...(input.provenance.note ? { note: input.provenance.note } : {}),
      },
      links,
      mutation_log: [],
      body: input.body,
    };

    const pathIndex = this.loadPathIndex();
    this.writeRecord(record, pathIndex);
    this.savePathIndex(pathIndex);

    const graph = this.loadGraph();
    addLinksToGraph(graph, id, links);
    this.saveGraph(graph);

    if (aliasIndex) this.saveAliasIndex(aliasIndex);

    return id;
  }

  // ── update (§6.2) ──────────────────────────────────────────────────────

  async update(
    id: string,
    fields: UpdateFields,
    evidence: UpdateEvidence,
  ): Promise<void> {
    return this.files.mutate('update', () =>
      this.updateLocked(id, fields, evidence),
    );
  }

  private updateLocked(
    id: string,
    fields: UpdateFields,
    evidence: UpdateEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'update: missing required evidence field: agent',
      );
    }

    const pathIndex = this.loadPathIndex();
    const record = this.readRecord(id, pathIndex);
    if (!record) throw new KnowledgeRecordNotFoundError(id);

    const mutableKeys = [
      'title',
      'body',
      'category',
      'tags',
      'links',
      'aliases',
      'expires_at',
      'ttl_seconds',
    ] as const;
    const suppliedFields = fields as Record<string, unknown>;
    const supplied = mutableKeys.filter((k) => suppliedFields[k] !== undefined);
    if (supplied.length === 0) {
      throw new MissingEvidenceError(
        'update: at least one mutable field must be supplied',
      );
    }

    if (fields.category !== undefined && !isValidCategory(fields.category)) {
      throw new MissingEvidenceError(
        `update: invalid category: ${fields.category}`,
      );
    }

    const fresh = freshnessPatch(fields);
    const now = new Date().toISOString();

    const mergedAliases: string[] = Array.isArray(record.aliases)
      ? record.aliases.slice()
      : [];
    let aliasIndex: AliasIndex | null = null;
    if (fields.aliases !== undefined) {
      const incoming = normalizeAliases(fields.aliases);
      const seen = new Set(mergedAliases);
      for (const slug of incoming) {
        if (!seen.has(slug)) {
          seen.add(slug);
          mergedAliases.push(slug);
        }
      }
      aliasIndex = this.loadAliasIndex();
      registerAliases(aliasIndex, id, mergedAliases);
    }

    let newLinks: KitLink[] = record.links ?? [];
    if (fields.links !== undefined) {
      const wikilinks = extractWikilinks(
        fields.body !== undefined ? fields.body : record.body,
      );
      newLinks = mergeLinks(fields.links, wikilinks);
    } else if (fields.body !== undefined) {
      const wikilinks = extractWikilinks(fields.body);
      newLinks = mergeLinks(record.links ?? [], wikilinks);
    }

    const updated: KitRecord = {
      ...record,
      ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.body !== undefined ? { body: fields.body } : {}),
      ...(fields.category !== undefined ? { category: fields.category } : {}),
      ...(fields.tags !== undefined ? { tags: fields.tags } : {}),
      ...(mergedAliases.length ? { aliases: mergedAliases } : {}),
      ...fresh,
      links: newLinks,
      updated_at: now,
      mutation_log: [
        ...(record.mutation_log ?? []),
        {
          op: 'update',
          at: now,
          agent: evidence.agent,
          ...(evidence.note ? { note: evidence.note } : {}),
          evidence: { fields: supplied },
        },
      ],
    };

    const graph = this.loadGraph();
    removeLinksFromGraph(graph, id);
    addLinksToGraph(graph, id, newLinks);
    this.saveGraph(graph);

    this.writeRecord(updated, pathIndex);
    this.savePathIndex(pathIndex);

    if (aliasIndex) this.saveAliasIndex(aliasIndex);
  }

  // ── link (§6.3) ────────────────────────────────────────────────────────

  async link(
    sourceId: string,
    links: KitLink[],
    evidence: LinkEvidence,
  ): Promise<void> {
    return this.files.mutate('link', () =>
      this.linkLocked(sourceId, links, evidence),
    );
  }

  private linkLocked(
    sourceId: string,
    links: KitLink[],
    evidence: LinkEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'link: missing required evidence field: agent',
      );
    }
    if (!links || links.length === 0) {
      throw new MissingEvidenceError('link: links array must be non-empty');
    }

    const pathIndex = this.loadPathIndex();
    const source = this.readRecord(sourceId, pathIndex);
    if (!source) throw new KnowledgeRecordNotFoundError(sourceId);

    for (const l of links) {
      if (!this.readRecord(l.target_id, pathIndex)) {
        throw new KnowledgeRecordNotFoundError(l.target_id);
      }
    }

    const now = new Date().toISOString();
    const newLinks = appendUniqueLinks(source.links ?? [], links);

    const updated: KitRecord = {
      ...source,
      links: newLinks,
      updated_at: now,
      mutation_log: [
        ...(source.mutation_log ?? []),
        {
          op: 'link',
          at: now,
          agent: evidence.agent,
          ...(evidence.note ? { note: evidence.note } : {}),
          evidence: { added: links },
        },
      ],
    };

    const graph = this.loadGraph();
    removeLinksFromGraph(graph, sourceId);
    addLinksToGraph(graph, sourceId, newLinks);
    this.saveGraph(graph);

    this.writeRecord(updated, pathIndex);
    this.savePathIndex(pathIndex);
  }

  // ── propose (§6.4) ─────────────────────────────────────────────────────

  async propose(
    conceptId: string,
    proposerId: string,
    evidence: ProposeEvidence,
  ): Promise<void> {
    return this.files.mutate('propose', () =>
      this.proposeLocked(conceptId, proposerId, evidence),
    );
  }

  private proposeLocked(
    conceptId: string,
    proposerId: string,
    evidence: ProposeEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'propose: missing required evidence field: agent',
      );
    }
    if (!evidence?.proposal?.trim()) {
      throw new MissingEvidenceError(
        'propose: missing required evidence field: proposal',
      );
    }

    const pathIndex = this.loadPathIndex();
    const concept = this.readRecord(conceptId, pathIndex);
    if (!concept) throw new KnowledgeRecordNotFoundError(conceptId);
    if (concept.type !== 'concept') {
      throw new MissingEvidenceError(
        `propose: concept_id ${conceptId} is not of type "concept" (got: ${concept.type})`,
      );
    }

    const proposer = this.readRecord(proposerId, pathIndex);
    if (!proposer) throw new KnowledgeRecordNotFoundError(proposerId);

    const now = new Date().toISOString();

    const proposerLinks = proposer.links ?? [];
    const alreadyLinked = proposerLinks.some(
      (l) => l.target_id === conceptId && l.kind === 'proposes',
    );
    if (!alreadyLinked) {
      const updatedProposer: KitRecord = {
        ...proposer,
        links: [...proposerLinks, { target_id: conceptId, kind: 'proposes' }],
        updated_at: now,
        mutation_log: [
          ...(proposer.mutation_log ?? []),
          {
            op: 'propose',
            at: now,
            agent: evidence.agent,
            evidence: { concept_id: conceptId, proposal: evidence.proposal },
          },
        ],
      };
      this.writeRecord(updatedProposer, pathIndex);

      const graph = this.loadGraph();
      removeLinksFromGraph(graph, proposerId);
      addLinksToGraph(graph, proposerId, updatedProposer.links ?? []);
      this.saveGraph(graph);
    }

    const updatedConcept: KitRecord = {
      ...concept,
      mutation_log: [
        ...(concept.mutation_log ?? []),
        {
          op: 'propose',
          at: now,
          agent: evidence.agent,
          evidence: { proposer_id: proposerId, proposal: evidence.proposal },
        },
      ],
    };
    this.writeRecord(updatedConcept, pathIndex);
    this.savePathIndex(pathIndex);
  }

  // ── apply (§6.5) ───────────────────────────────────────────────────────

  async apply(
    conceptId: string,
    proposerId: string,
    evidence: ApplyEvidence,
  ): Promise<void> {
    return this.files.mutate('apply', () =>
      this.applyLocked(conceptId, proposerId, evidence),
    );
  }

  private applyLocked(
    conceptId: string,
    proposerId: string,
    evidence: ApplyEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'apply: missing required evidence field: agent',
      );
    }
    if (typeof evidence?.new_body !== 'string' || !evidence.new_body.trim()) {
      throw new MissingEvidenceError(
        'apply: missing required evidence field: new_body',
      );
    }
    if (!evidence?.rationale?.trim()) {
      throw new MissingEvidenceError(
        'apply: missing required evidence field: rationale',
      );
    }

    const pathIndex = this.loadPathIndex();
    const concept = this.readRecord(conceptId, pathIndex);
    if (!concept) throw new KnowledgeRecordNotFoundError(conceptId);
    if (concept.type !== 'concept') {
      throw new MissingEvidenceError(
        `apply: concept_id ${conceptId} is not of type "concept" (got: ${concept.type})`,
      );
    }

    const proposer = this.readRecord(proposerId, pathIndex);
    if (!proposer) throw new KnowledgeRecordNotFoundError(proposerId);

    const proposerLinks = proposer.links ?? [];
    const hasProposesLink = proposerLinks.some(
      (l) => l.target_id === conceptId && l.kind === 'proposes',
    );
    if (!hasProposesLink) {
      throw new MissingEvidenceError(
        `apply: no "proposes" link from ${proposerId} to ${conceptId}`,
      );
    }

    const now = new Date().toISOString();
    const updatedConcept: KitRecord = {
      ...concept,
      body: evidence.new_body,
      updated_at: now,
      mutation_log: [
        ...(concept.mutation_log ?? []),
        {
          op: 'apply',
          at: now,
          agent: evidence.agent,
          evidence: { proposer_id: proposerId, rationale: evidence.rationale },
        },
      ],
    };
    this.writeRecord(updatedConcept, pathIndex);
    this.savePathIndex(pathIndex);
  }

  // ── reject (§6.6) ──────────────────────────────────────────────────────

  async reject(
    conceptId: string,
    proposerId: string,
    evidence: RejectEvidence,
  ): Promise<void> {
    return this.files.mutate('reject', () =>
      this.rejectLocked(conceptId, proposerId, evidence),
    );
  }

  private rejectLocked(
    conceptId: string,
    proposerId: string,
    evidence: RejectEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'reject: missing required evidence field: agent',
      );
    }
    if (!evidence?.reason?.trim()) {
      throw new MissingEvidenceError(
        'reject: missing required evidence field: reason',
      );
    }

    const pathIndex = this.loadPathIndex();
    const concept = this.readRecord(conceptId, pathIndex);
    if (!concept) throw new KnowledgeRecordNotFoundError(conceptId);
    if (concept.type !== 'concept') {
      throw new MissingEvidenceError(
        `reject: concept_id ${conceptId} is not of type "concept" (got: ${concept.type})`,
      );
    }

    const proposer = this.readRecord(proposerId, pathIndex);
    if (!proposer) throw new KnowledgeRecordNotFoundError(proposerId);

    const proposerLinks = proposer.links ?? [];
    const hasProposesLink = proposerLinks.some(
      (l) => l.target_id === conceptId && l.kind === 'proposes',
    );
    if (!hasProposesLink) {
      throw new MissingEvidenceError(
        `reject: no "proposes" link from ${proposerId} to ${conceptId}`,
      );
    }

    const now = new Date().toISOString();
    const updatedConcept: KitRecord = {
      ...concept,
      mutation_log: [
        ...(concept.mutation_log ?? []),
        {
          op: 'reject',
          at: now,
          agent: evidence.agent,
          evidence: { proposer_id: proposerId, reason: evidence.reason },
        },
      ],
    };
    this.writeRecord(updatedConcept, pathIndex);
    this.savePathIndex(pathIndex);
  }

  // ── supersede (Addendum A.5/A.6) ──────────────────────────────────────

  async supersede(
    newId: string,
    supersededIds: string[],
    evidence: SupersedeEvidence,
  ): Promise<void> {
    return this.files.mutate('supersede', () =>
      this.supersedeLocked(newId, supersededIds, evidence),
    );
  }

  private supersedeLocked(
    newId: string,
    supersededIds: string[],
    evidence: SupersedeEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'supersede: missing required evidence field: agent',
      );
    }
    if (!evidence?.rationale?.trim()) {
      throw new MissingEvidenceError(
        'supersede: missing required evidence field: rationale',
      );
    }
    if (!supersededIds || supersededIds.length === 0) {
      throw new MissingEvidenceError(
        'supersede: supersededIds must be a non-empty array',
      );
    }

    const pathIndex = this.loadPathIndex();
    const newRecord = this.readRecord(newId, pathIndex);
    if (!newRecord) throw new KnowledgeRecordNotFoundError(newId);

    for (const sid of supersededIds) {
      if (!this.readRecord(sid, pathIndex)) {
        throw new KnowledgeRecordNotFoundError(sid);
      }
    }

    const now = new Date().toISOString();

    const supersededLinks: KitLink[] = supersededIds.map((sid) => ({
      target_id: sid,
      kind: 'supersedes',
    }));

    const newLinks = appendUniqueLinks(newRecord.links ?? [], supersededLinks);

    const updatedNew: KitRecord = {
      ...newRecord,
      links: newLinks,
      updated_at: now,
      mutation_log: [
        ...(newRecord.mutation_log ?? []),
        {
          op: 'supersede',
          at: now,
          agent: evidence.agent,
          rationale: evidence.rationale,
          ...(evidence.note ? { note: evidence.note } : {}),
          evidence: { superseded_count: supersededIds.length },
        },
      ],
    };

    const graph = this.loadGraph();
    removeLinksFromGraph(graph, newId);
    addLinksToGraph(graph, newId, newLinks);
    this.saveGraph(graph);

    this.writeRecord(updatedNew, pathIndex);

    // Records are NOT deleted — supersede-not-delete invariant (A.5). Each superseded
    // record gets its mutation-log entry written at its CURRENT (pre-archive) path,
    // then is moved to archive/.
    for (const sid of supersededIds) {
      const supersededRecord = this.readRecord(sid, pathIndex);
      if (!supersededRecord) continue; // already verified above; defensive.
      const updatedSuperseded: KitRecord = {
        ...supersededRecord,
        mutation_log: [
          ...(supersededRecord.mutation_log ?? []),
          {
            op: 'superseded-by',
            at: now,
            agent: evidence.agent,
            new_id: newId,
            rationale: evidence.rationale,
            ...(evidence.note ? { note: evidence.note } : {}),
            evidence: { superseded_by_id: newId },
          },
        ],
      };
      this.writeRecord(updatedSuperseded, pathIndex);
      this.archiveRecord(sid, pathIndex);
    }

    this.savePathIndex(pathIndex);
  }

  // ── retire (Addendum B.4/B.5) ─────────────────────────────────────────

  async retire(
    id: string,
    targetStatus: 'implemented' | 'retired',
    evidence: RetireEvidence,
  ): Promise<void> {
    return this.files.mutate('retire', () =>
      this.retireLocked(id, targetStatus, evidence),
    );
  }

  private retireLocked(
    id: string,
    targetStatus: 'implemented' | 'retired',
    evidence: RetireEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'retire: missing required evidence field: agent',
      );
    }
    if (!evidence?.rationale?.trim()) {
      throw new MissingEvidenceError(
        'retire: missing required evidence field: rationale',
      );
    }
    if (targetStatus !== 'implemented' && targetStatus !== 'retired') {
      throw new MissingEvidenceError(
        `retire: targetStatus must be "implemented" or "retired"; got: ${targetStatus}`,
      );
    }
    if (targetStatus === 'implemented' && !evidence.implementedByRef?.trim()) {
      throw new MissingEvidenceError(
        'retire: implementedByRef is required when targetStatus is "implemented"',
      );
    }

    const pathIndex = this.loadPathIndex();
    const record = this.readRecord(id, pathIndex);
    if (!record) throw new KnowledgeRecordNotFoundError(id);

    const currentStatus = record.status ?? 'active';
    const allowed = VALID_STATUS_TRANSITIONS[currentStatus];
    if (!allowed?.has(targetStatus)) {
      throw new MissingEvidenceError(
        `retire: invalid transition from "${currentStatus}" to "${targetStatus}"`,
      );
    }

    const now = new Date().toISOString();
    const updated: KitRecord = {
      ...record,
      status: targetStatus,
      updated_at: now,
      mutation_log: [
        ...(record.mutation_log ?? []),
        {
          op: 'retire',
          at: now,
          agent: evidence.agent,
          ...(evidence.note ? { note: evidence.note } : {}),
          evidence: {
            targetStatus,
            rationale: evidence.rationale,
            ...(evidence.implementedByRef
              ? { implementedByRef: evidence.implementedByRef }
              : {}),
            ...(evidence.supersededByRef
              ? { supersededByRef: evidence.supersededByRef }
              : {}),
          },
        },
      ],
    };
    this.writeRecord(updated, pathIndex);
    this.savePathIndex(pathIndex);
  }

  // ── get / getLinks (§7, Addendum H) ───────────────────────────────────

  async get(idOrHandle: string): Promise<KitRecord | null> {
    return this.files.read(() => {
      const pathIndex = this.loadPathIndex();
      const resolvedId = this.resolveId(idOrHandle, pathIndex);
      if (!resolvedId) return null;
      return this.readRecord(resolvedId, pathIndex);
    });
  }

  async getLinks(
    idOrHandle: string,
  ): Promise<{ forward: KitLink[]; reverse: KitReverseLink[] }> {
    return this.files.read(() => {
      const key = this.resolveId(idOrHandle) ?? idOrHandle;
      const graph = this.loadGraph();
      return {
        forward: (graph.forward[key] ?? []).map((l) => ({ ...l })),
        reverse: (graph.reverse[key] ?? []).map((l) => ({ ...l })),
      };
    });
  }

  // ── listByCategory / listByType (§7, B.3/B.5) ─────────────────────────

  async listByCategory(
    category: string,
    options: { prefix?: boolean; includeRetired?: boolean } = {},
  ): Promise<KitRecord[]> {
    return this.files.read(() => {
      const includeRetired = options.includeRetired === true;
      const keep = (r: KitRecord) =>
        includeRetired || (r.status ?? 'active') !== 'retired';
      const records = this.allRecords(this.loadPathIndex());
      if (options.prefix) {
        return records.filter(
          (r) =>
            (r.category === category ||
              r.category.startsWith(`${category}.`)) &&
            keep(r),
        );
      }
      return records.filter((r) => r.category === category && keep(r));
    });
  }

  async listByType(
    type: KitRecordType,
    options: { includeRetired?: boolean } = {},
  ): Promise<KitRecord[]> {
    return this.files.read(() => {
      const includeRetired = options.includeRetired === true;
      return this.allRecords(this.loadPathIndex()).filter(
        (r) =>
          r.type === type &&
          (includeRetired || (r.status ?? 'active') !== 'retired'),
      );
    });
  }
}

export const kitObsidianStoreAdapterDescriptor: KnowledgeAdapterDescriptor = {
  id: 'kit-obsidian-store',
  displayName: 'Obsidian Vault Store',
  create: async (options) => new KitObsidianStoreAdapter(options),
  /**
   * K4 onboarding hook (built now so K4 doesn't need to touch this adapter later):
   * a real vault-shaped directory (has `.obsidian/` or is non-empty) is `ok: true`; a
   * missing path or an empty/garbage directory is `ok: false` with a named reason.
   */
  validateRoot: async (storeRoot: string) => {
    const resolved = resolve(storeRoot);
    if (!existsSync(resolved)) {
      return { ok: false, reason: 'storeRoot does not exist' };
    }
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      return { ok: false, reason: 'storeRoot is not a directory' };
    }
    if (existsSync(join(resolved, '.obsidian'))) {
      return { ok: true };
    }
    const entries = readdirSync(resolved);
    if (entries.length > 0) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: 'storeRoot is an empty directory with no .obsidian/ vault marker',
    };
  },
};
