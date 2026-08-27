import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  KitObsidianStoreAdapter,
  kitObsidianStoreAdapterDescriptor,
} from '../obsidian-store.js';
import { runAdapterContractSuite } from './contract-suite.js';

// Spy on the shared logger factory (M1/M2 fixes below assert warning breadcrumbs for
// the reserved-key and external-edit edge cases) — same pattern as
// `default-store.contract.test.ts`. `vi.hoisted` is required because `vi.mock`
// factories are hoisted above normal `const`s.
const { loggerWarnSpy } = vi.hoisted(() => ({ loggerWarnSpy: vi.fn() }));
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: loggerWarnSpy,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// The adapter-agnostic behavioral contract is shared with `kit-default-store` — see
// `contract-suite.ts`. This file keeps only what is genuinely specific to the
// Obsidian-vault-shaped layout: person routing (Addendum C.3), archive-on-supersede
// folder placement, and `validateRoot` (the K4 onboarding hook).
function findObsidianRecordFilePath(dir: string, id: string): string {
  const pathIndex = JSON.parse(
    readFileSync(join(dir, 'path-index.json'), 'utf-8'),
  ) as { by_id: Record<string, { path: string; archived: boolean }> };
  const entry = pathIndex.by_id[id];
  if (!entry) {
    throw new Error(`No path-index.json entry for id ${id}`);
  }
  return join(dir, entry.path);
}

runAdapterContractSuite({
  label: 'kit-obsidian-store',
  createAdapter: (storeRoot) => new KitObsidianStoreAdapter({ storeRoot }),
  findRecordFilePath: findObsidianRecordFilePath,
});

describe('KitObsidianStoreAdapter — vault-shape assertions (store-contract.md Addendum C.3, obsidian-store README)', () => {
  let dir: string;
  let adapter: KitObsidianStoreAdapter;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kit-obsidian-store-vault-'));
    adapter = new KitObsidianStoreAdapter({ storeRoot: dir });
    loggerWarnSpy.mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('person records land in people/ regardless of the supplied category', async () => {
    const id = await adapter.create({
      type: 'person',
      title: 'Dana Smith',
      body: '**Role/Org:** Engineering lead',
      category: 'engineering.staff', // deliberately non-"people" category — must be ignored for routing
      provenance: { agent: 'entity-extractor' },
    });

    expect(existsSync(join(dir, 'people', 'dana-smith.md'))).toBe(true);
    // The category field itself is preserved in frontmatter (routing ignores it; the
    // contract field is untouched).
    const record = await adapter.get(id);
    expect(record?.category).toBe('engineering.staff');
    expect(record?.type).toBe('person');
  });

  test('raw/compiled records nest under the sources/ subfolder; concept/snapshot sit at the category root', async () => {
    const rawId = await adapter.create({
      type: 'raw',
      title: 'Field note',
      body: 'raw text',
      category: 'engineering.onboarding',
      provenance: { agent: 'agent-1' },
    });
    const conceptId = await adapter.create({
      type: 'concept',
      title: 'Onboarding friction',
      body: 'concept text',
      category: 'engineering.onboarding',
      provenance: { agent: 'agent-1' },
    });

    expect(
      existsSync(
        join(dir, 'engineering', 'onboarding', 'sources', 'field-note.md'),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(dir, 'engineering', 'onboarding', 'onboarding-friction.md'),
      ),
    ).toBe(true);
    expect(await adapter.get(rawId)).not.toBeNull();
    expect(await adapter.get(conceptId)).not.toBeNull();
  });

  test('filename slug collisions (same slug, different id) get a numeric suffix', async () => {
    const firstId = await adapter.create({
      type: 'concept',
      title: 'Duplicate Title',
      body: 'first',
      category: 'engineering',
      provenance: { agent: 'agent-1' },
    });
    const secondId = await adapter.create({
      type: 'concept',
      title: 'Duplicate Title',
      body: 'second',
      category: 'engineering',
      provenance: { agent: 'agent-1' },
    });

    expect(firstId).not.toBe(secondId);
    expect(existsSync(join(dir, 'engineering', 'duplicate-title.md'))).toBe(
      true,
    );
    expect(existsSync(join(dir, 'engineering', 'duplicate-title-2.md'))).toBe(
      true,
    );
    expect((await adapter.get(firstId))?.body).toBe('first');
    expect((await adapter.get(secondId))?.body).toBe('second');
  });

  test("supersede MOVES the superseded record's file to archive/, preserving its relative path, and it remains gettable", async () => {
    const oldId = await adapter.create({
      type: 'compiled',
      title: 'Old summary',
      body: 'stale',
      category: 'engineering.decisions',
      provenance: { agent: 'agent-1' },
    });
    const newId = await adapter.create({
      type: 'compiled',
      title: 'New summary',
      body: 'fresh',
      category: 'engineering.decisions',
      provenance: { agent: 'agent-1' },
    });

    const preArchivePath = join(
      dir,
      'engineering',
      'decisions',
      'sources',
      'old-summary.md',
    );
    expect(existsSync(preArchivePath)).toBe(true);

    await adapter.supersede(newId, [oldId], {
      agent: 'agent-1',
      rationale: 'newer data',
    });

    expect(existsSync(preArchivePath)).toBe(false);
    expect(
      existsSync(
        join(
          dir,
          'archive',
          ...preArchivePath.slice(dir.length + 1).split('/'),
        ),
      ),
    ).toBe(true);

    // Still gettable and still excluded from the active listing (Addendum J.3: the
    // cross-adapter supersession surface is get()/getLinks().reverse, not listByType —
    // see contract-suite.ts's header note for why listByType inclusion isn't asserted
    // identically across adapters).
    const record = await adapter.get(oldId);
    expect(record).not.toBeNull();
    expect(record?.body).toBe('stale');
    const listed = await adapter.listByType('compiled', {
      includeRetired: true,
    });
    expect(listed.find((r) => r.id === oldId)).toBeUndefined();
  });

  test('a record file is genuinely Obsidian-readable: frontmatter excludes body; body renders below the fence with the sentinel', async () => {
    const id = await adapter.create({
      type: 'compiled',
      title: 'Fixture record',
      body: 'Body text with a [[wikilink-target]] reference.',
      category: 'engineering.fixtures',
      provenance: { agent: 'fixture-agent' },
    });

    const filePath = join(
      dir,
      'engineering',
      'fixtures',
      'sources',
      'fixture-record.md',
    );
    expect(existsSync(filePath)).toBe(true);
    const raw = readFileSync(filePath, 'utf-8');

    expect(raw.startsWith('---\n')).toBe(true);
    const end = raw.indexOf('\n---\n', 4);
    const frontmatterText = raw.slice(4, end);
    expect(frontmatterText).not.toContain('body:');

    const renderedBody = raw.slice(end + 5);
    expect(renderedBody).toContain(
      'Body text with a [[wikilink-target]] reference.',
    );
    expect(renderedBody).toContain('<!-- kit:body-end -->');

    // Round-trips correctly despite body living outside frontmatter.
    const record = await adapter.get(id);
    expect(record?.body).toBe(
      'Body text with a [[wikilink-target]] reference.',
    );
  });

  test('raw records wrap the body in a collapsed callout for readability, losslessly', async () => {
    const id = await adapter.create({
      type: 'raw',
      title: 'Raw callout fixture',
      body: 'line one\nline two',
      category: 'engineering',
      provenance: { agent: 'agent-1' },
    });

    const filePath = join(
      dir,
      'engineering',
      'sources',
      'raw-callout-fixture.md',
    );
    const raw = readFileSync(filePath, 'utf-8');
    expect(raw).toContain('> [!note]- Raw Notes');
    expect(raw).toContain('> line one');
    expect(raw).toContain('> line two');

    const record = await adapter.get(id);
    expect(record?.body).toBe('line one\nline two');
  });

  // L2 (Wave-2 review, LOW): raw-callout body preservation is only pinned through
  // create() -> get() above; this pins it through update() too, since `writeRecord`
  // unconditionally re-derives the callout wrapping from `record.type` on every
  // write, not just the first one.
  test('raw-callout body wrapping survives an update() body change, losslessly', async () => {
    const id = await adapter.create({
      type: 'raw',
      title: 'Raw callout update fixture',
      body: 'original line one\noriginal line two',
      category: 'engineering',
      provenance: { agent: 'agent-1' },
    });

    await adapter.update(
      id,
      { body: 'updated line one\nupdated line two\nupdated line three' },
      { agent: 'agent-1' },
    );

    const filePath = join(
      dir,
      'engineering',
      'sources',
      'raw-callout-update-fixture.md',
    );
    const raw = readFileSync(filePath, 'utf-8');
    expect(raw).toContain('> [!note]- Raw Notes');
    expect(raw).toContain('> updated line one');
    expect(raw).toContain('> updated line two');
    expect(raw).toContain('> updated line three');
    expect(raw).not.toContain('original line one');

    const record = await adapter.get(id);
    expect(record?.type).toBe('raw');
    expect(record?.body).toBe(
      'updated line one\nupdated line two\nupdated line three',
    );
  });

  // H1 (Wave-2 review, HIGH — sentinel collision corrupts bodies): a body containing
  // the literal `<!-- kit:body-end -->` sentinel string must round-trip byte-exact,
  // not silently truncate. See `chooseBodySentinel()` in obsidian-store.ts for the
  // collision-proof scheme (a length-pigeonhole proof, not an escape/unescape pass).
  describe('sentinel-collision handling (H1 fix)', () => {
    test('(a) a body containing the plain sentinel string round-trips byte-exact', async () => {
      const body =
        'Before the marker.\n<!-- kit:body-end -->\nAfter the marker — this must survive.';
      const id = await adapter.create({
        type: 'concept',
        title: 'Sentinel collision — single occurrence',
        body,
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      const record = await adapter.get(id);
      expect(record?.body).toBe(body);
    });

    test('(b) a body containing the sentinel string multiple times round-trips byte-exact', async () => {
      const body = [
        'Intro paragraph.',
        '<!-- kit:body-end -->',
        'Middle paragraph, still part of the body.',
        '<!-- kit:body-end -->',
        'Tail paragraph — must also survive.',
      ].join('\n');
      const id = await adapter.create({
        type: 'concept',
        title: 'Sentinel collision — multiple occurrences',
        body,
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      const record = await adapter.get(id);
      expect(record?.body).toBe(body);
    });

    test('(c) a body containing a lengthened sentinel form round-trips byte-exact (recursion case)', async () => {
      // Deliberately adversarial: the body contains text SHAPED like a sentinel this
      // same collision-avoidance scheme could itself produce for some other, shorter
      // body — proving the fix does not just special-case the bare default marker.
      const fakeLengthenedSentinel = `<!-- kit:body-end:${'x'.repeat(50)} -->`;
      const body = [
        'Header content.',
        fakeLengthenedSentinel,
        'Footer content that must also survive, unmodified.',
      ].join('\n');
      const id = await adapter.create({
        type: 'concept',
        title: 'Sentinel collision — recursion case',
        body,
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      const record = await adapter.get(id);
      expect(record?.body).toBe(body);
    });

    test('(d) a sentinel-colliding body survives create -> read -> update -> read', async () => {
      const bodyV1 = 'Version one.\n<!-- kit:body-end -->\nStill version one.';
      const id = await adapter.create({
        type: 'concept',
        title: 'Sentinel collision — update cycle',
        body: bodyV1,
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      expect((await adapter.get(id))?.body).toBe(bodyV1);

      const bodyV2 = [
        'Version two, first paragraph.',
        '<!-- kit:body-end -->',
        'Version two, second paragraph.',
        '<!-- kit:body-end -->',
        'Version two, third paragraph.',
      ].join('\n');
      await adapter.update(id, { body: bodyV2 }, { agent: 'agent-1' });
      expect((await adapter.get(id))?.body).toBe(bodyV2);
    });

    test('a sentinel-colliding raw-type body (post callout-quoting) also round-trips byte-exact', async () => {
      // The raw-callout `"> "` line-quoting happens BEFORE the sentinel is appended,
      // so this exercises collision detection against the fully-rendered bodyPart,
      // not just the raw, unwrapped `record.body`.
      const body = 'raw line one\n<!-- kit:body-end -->\nraw line two';
      const id = await adapter.create({
        type: 'raw',
        title: 'Sentinel collision — raw callout',
        body,
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      const record = await adapter.get(id);
      expect(record?.body).toBe(body);
    });
  });

  // M1/M2 (Wave-2 code review iteration 2): the `_body_sentinel` bookkeeping key must
  // never leak onto the public `KitRecord`, must not crash a read (or misbehave) if a
  // user coincidentally has their own value under that key, and the sentinel-boundary
  // read semantics must stay well-defined against a file edited outside Station (this
  // adapter's own advertised "browse as a normal Obsidian vault" flow).
  describe('_body_sentinel reserved-key handling + external-edit read semantics (M1/M2 fix)', () => {
    test('M1: the internal _body_sentinel bookkeeping key never leaks onto the public KitRecord returned by get()/listByType()/listByCategory()', async () => {
      // Use a sentinel-colliding body so a non-default `_body_sentinel` value is
      // actually written to frontmatter — the leak is only observable in that case.
      const collidingBody =
        'Body containing the marker.\n<!-- kit:body-end -->\nTail, must survive.';
      const id = await adapter.create({
        type: 'concept',
        title: 'Sentinel key leak check',
        body: collidingBody,
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      const record = await adapter.get(id);
      expect(record).not.toBeNull();
      expect(record?.body).toBe(collidingBody);
      expect(Object.hasOwn(record as object, '_body_sentinel')).toBe(false);

      const listed = await adapter.listByType('concept');
      const listedRecord = listed.find((r) => r.id === id);
      expect(listedRecord).toBeDefined();
      expect(Object.hasOwn(listedRecord as object, '_body_sentinel')).toBe(
        false,
      );

      const listedByCategory = await adapter.listByCategory('engineering');
      const listedByCategoryRecord = listedByCategory.find((r) => r.id === id);
      expect(listedByCategoryRecord).toBeDefined();
      expect(
        Object.hasOwn(listedByCategoryRecord as object, '_body_sentinel'),
      ).toBe(false);
    });

    test('M1 edge case: a user-authored, non-adapter-shaped _body_sentinel frontmatter value does not crash the read — falls back to the default sentinel and warns', async () => {
      const body = 'Ordinary body, no marker at all.';
      const id = await adapter.create({
        type: 'concept',
        title: 'Coincidental reserved-key collision',
        body,
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      const filePath = findObsidianRecordFilePath(dir, id);
      const raw = readFileSync(filePath, 'utf-8');
      // A record this adapter created with a non-colliding body never writes
      // `_body_sentinel` to frontmatter — hand-inject a garbage, non-adapter-shaped
      // value under that reserved key directly, as if a human (or another tool)
      // coincidentally chose the same key name for something unrelated.
      const tampered = raw.replace(
        /^---\n/,
        '---\n_body_sentinel: "this is not a real sentinel"\n',
      );
      writeFileSync(filePath, tampered, 'utf-8');

      loggerWarnSpy.mockClear();
      const record = await adapter.get(id);
      expect(record).not.toBeNull();
      expect(record?.body).toBe(body);
      expect(Object.hasOwn(record as object, '_body_sentinel')).toBe(false);
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('malformed _body_sentinel'),
        expect.objectContaining({ id }),
      );
    });

    test('M2: external edit inserting the default sentinel mid-body (no frontmatter update) does not truncate — last-occurrence anchoring makes the paste inert (reviewer repro, red→green anchor)', async () => {
      const originalBody = 'Paragraph one.\n\nParagraph two.';
      const id = await adapter.create({
        type: 'concept',
        title: 'External edit — mid-body sentinel paste',
        body: originalBody,
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      const filePath = findObsidianRecordFilePath(dir, id);
      const raw = readFileSync(filePath, 'utf-8');
      expect(raw.trimEnd().endsWith('<!-- kit:body-end -->')).toBe(true);

      // Simulate a human directly editing the vault file (the adapter's own advertised
      // "browse as a normal Obsidian vault" flow) to paste a second, literal copy of
      // the default sentinel mid-body, without touching frontmatter — there is nothing
      // to update even if the human wanted to, since `_body_sentinel` is never written
      // for a non-colliding body.
      const humanEdited = raw.replace(
        'Paragraph two.',
        'Paragraph two.\n<!-- kit:body-end -->\nParagraph three, added by a human, after the real ending.',
      );
      writeFileSync(filePath, humanEdited, 'utf-8');

      const record = await adapter.get(id);
      expect(record?.body).toBe(
        'Paragraph one.\n\nParagraph two.\n<!-- kit:body-end -->\nParagraph three, added by a human, after the real ending.',
      );
    });

    test('M2: external edit deleting the trailing sentinel entirely reads to EOF (no truncation), warns, and self-heals a fresh sentinel on the next Station-driven write', async () => {
      const originalBody = 'Kept forever, hopefully.';
      const id = await adapter.create({
        type: 'concept',
        title: 'External edit — sentinel deleted',
        body: originalBody,
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      const filePath = findObsidianRecordFilePath(dir, id);
      const raw = readFileSync(filePath, 'utf-8');
      const withoutSentinel = raw.replace('\n<!-- kit:body-end -->', '');
      expect(withoutSentinel).not.toEqual(raw);
      writeFileSync(filePath, withoutSentinel, 'utf-8');

      loggerWarnSpy.mockClear();
      const record = await adapter.get(id);
      expect(record?.body).toBe(originalBody);
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('missing its structural sentinel'),
        expect.objectContaining({ id }),
      );

      // Self-heal: any Station-driven write re-derives + re-appends a fresh sentinel.
      // Use a non-title mutation so the file path is stable (title changes move the
      // file under this adapter's title-routed layout, which isn't the concern here).
      await adapter.update(id, { tags: ['retagged'] }, { agent: 'agent-1' });
      const healedRaw = readFileSync(filePath, 'utf-8');
      expect(healedRaw).toContain('<!-- kit:body-end -->');
      const healedRecord = await adapter.get(id);
      expect(healedRecord?.body).toBe(originalBody);
    });

    test('M2: pathological content hand-added after the sentinel (not a recognized generated section) is merged back into the body on read instead of being silently discarded, with a warning', async () => {
      const originalBody = 'Original body content.';
      const id = await adapter.create({
        type: 'concept',
        title: 'External edit — pathological trailing content',
        body: originalBody,
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      const filePath = findObsidianRecordFilePath(dir, id);
      const raw = readFileSync(filePath, 'utf-8');
      const humanNote =
        'Hand-typed note a human added directly below the sentinel, not through Station.';
      writeFileSync(filePath, `${raw}\n\n${humanNote}`, 'utf-8');

      loggerWarnSpy.mockClear();
      const record = await adapter.get(id);
      expect(record?.body).toBe(`${originalBody}\n\n${humanNote}`);
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'unrecognized content after its structural sentinel',
        ),
        expect.objectContaining({ id }),
      );
    });

    test('M2: recognized generated sections after the sentinel (Sources/Related) are NOT treated as pathological content and do not leak into body', async () => {
      const targetId = await adapter.create({
        type: 'concept',
        title: 'Link target',
        body: 'target body',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      const id = await adapter.create({
        type: 'concept',
        title: 'Has a Sources section',
        body: 'Body content, nothing unusual.',
        category: 'engineering',
        links: [{ target_id: targetId, kind: 'source' }],
        provenance: { agent: 'agent-1' },
      });

      const filePath = findObsidianRecordFilePath(dir, id);
      const raw = readFileSync(filePath, 'utf-8');
      expect(raw).toContain('## Sources');

      loggerWarnSpy.mockClear();
      const record = await adapter.get(id);
      expect(record?.body).toBe('Body content, nothing unusual.');
      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });
  });

  // H1 (Wave-2 code review iteration 3 -> iteration 4 fix): last-occurrence anchoring's
  // premise ("generated sections never contain a line-exact sentinel") was falsified by
  // an unvalidated, newline-capable `KitLink.label` reaching a generated section via the
  // public `link()` API or `[[target|label]]` wikilink parsing. Fixed at the CLASS level
  // (see the adapter header comment's "(a)/(b)/(c)" block): (a) root-cause sanitization
  // in `shared/wikilinks.ts` collapses embedded line breaks in any label before it is
  // ever persisted or rendered; (b) `renderObsidianBody` additionally neutralizes any
  // sentinel-shaped line inside a generated section regardless of which field produced
  // it, as a structural backstop.
  describe('H1 fix (Wave-2 code review iteration 4): label-injection sentinel corruption', () => {
    test('reviewer repro (red -> green): a link() label with an embedded newline placing the sentinel on its own line no longer corrupts the body', async () => {
      const targetId = await adapter.create({
        type: 'concept',
        title: 'Link target',
        body: 'target body',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      const sourceId = await adapter.create({
        type: 'concept',
        title: 'Link injection source',
        body: 'Paragraph one.\n\nParagraph two.',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      loggerWarnSpy.mockClear();
      // Exact reviewer repro shape (iteration 3 review, "M2" finding): a label whose
      // embedded newline places the literal default sentinel on its own physical line.
      await adapter.link(
        sourceId,
        [
          {
            target_id: targetId,
            kind: 'related',
            label: 'evil\n<!-- kit:body-end -->\nafter',
          },
        ],
        { agent: 'probe' },
      );

      // Pre-fix (iteration 3), this reproducibly corrupted the record: the real
      // sentinel line and the "## Related" heading were absorbed into `body`. Fixed:
      // the body round-trips exactly, untouched.
      const record = await adapter.get(sourceId);
      expect(record?.body).toBe('Paragraph one.\n\nParagraph two.');

      // Root-cause fix (a): the label was sanitized (newline collapsed to a space)
      // before being persisted at all, not merely defended against on render.
      const link = record?.links?.find((l) => l.target_id === targetId);
      expect(link?.label).toBe('evil <!-- kit:body-end --> after');
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('embedded line break'),
        expect.objectContaining({
          original: 'evil\n<!-- kit:body-end -->\nafter',
          sanitized: 'evil <!-- kit:body-end --> after',
        }),
      );

      // The rendered file never contains more than the one real, line-exact sentinel.
      const filePath = findObsidianRecordFilePath(dir, sourceId);
      const raw = readFileSync(filePath, 'utf-8');
      const sentinelLines = raw
        .split('\n')
        .filter((line) => line === '<!-- kit:body-end -->');
      expect(sentinelLines).toHaveLength(1);
    });

    test('wikilink-parse path: a body-embedded [[target|label]] whose label has an embedded newline is sanitized at parse time, not merely defended against on render', async () => {
      const targetId = await adapter.create({
        type: 'concept',
        title: 'Wikilink target',
        body: 'target body',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      loggerWarnSpy.mockClear();
      const body = `See [[${targetId}|evil\n<!-- kit:body-end -->\nafter]] for context.`;
      const id = await adapter.create({
        type: 'concept',
        title: 'Wikilink label newline',
        body,
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      // The body itself (including the raw [[...]] wikilink syntax) round-trips
      // exactly — no truncation, no data loss — regardless of the fact that it
      // happens to also contain the literal sentinel substring (already handled by
      // the iteration-1/2 H1 pigeonhole fix via a lengthened sentinel).
      const record = await adapter.get(id);
      expect(record?.body).toBe(body);

      // The label extracted from the wikilink was sanitized at parse time.
      const link = record?.links?.find((l) => l.target_id === targetId);
      expect(link?.label).toBe('evil <!-- kit:body-end --> after');
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('embedded line break'),
        expect.objectContaining({
          sanitized: 'evil <!-- kit:body-end --> after',
        }),
      );
    });

    // Renderer-level class test (defense-in-depth "(b)"). Originally written
    // (Wave-2 code review iteration 4) to prove `neutralizeSentinelShapedLines`
    // catches a sentinel-shaped label that bypasses write-time sanitization; that
    // exact bypass is no longer reachable through ANY write path as of the
    // Wave-3 fast-follow (`writeRecord` now calls `sanitizeLinks` unconditionally
    // BEFORE `renderObsidianBody` on every persisted write — see the adapter
    // header's Wave-3 note), so a hand-tampered legacy label is cleaned at the
    // frontmatter level before it can ever reach the renderer, and defense (b)
    // never has to fire for this vector. This test still proves the invariant
    // that matters — a legacy sentinel-shaped label can never survive a write
    // (whether via sanitization now firing earlier, or defense (b) as a second
    // layer for any field it doesn't happen to cover) — for EVERY generated-
    // section field type (Sources/Appears In/People/Related).
    test.each([
      { kind: 'source', heading: '## Sources', recordType: 'concept' as const },
      {
        kind: 'related',
        heading: '## Related',
        recordType: 'concept' as const,
      },
      { kind: 'person', heading: '## People', recordType: 'concept' as const },
      {
        kind: 'appears-in',
        heading: '## Appears In',
        recordType: 'person' as const,
      },
    ])(
      'generated section $heading (kind: $kind): a sentinel-shaped label hand-tampered onto disk is sanitized on the very next write, never corrupting the body',
      async ({ kind, heading, recordType }) => {
        const targetId = await adapter.create({
          type: 'concept',
          title: `Target for ${kind}`,
          body: 'target body',
          category: 'engineering',
          provenance: { agent: 'agent-1' },
        });
        const originalBody = 'Paragraph one.\n\nParagraph two.';
        const sourceId = await adapter.create({
          type: recordType,
          title: `Class test source for ${kind}`,
          body: originalBody,
          category: 'engineering',
          links: [
            { target_id: targetId, kind, label: 'SAFE_PLACEHOLDER_LABEL' },
          ],
          provenance: { agent: 'agent-1' },
        });

        // Hand-tamper the on-disk frontmatter to simulate a legacy/externally-
        // authored record whose label predates write-time sanitization entirely —
        // the malicious label is written directly as a YAML double-quoted scalar
        // with a real embedded newline placing the sentinel on its own physical
        // line.
        const filePath = findObsidianRecordFilePath(dir, sourceId);
        const maliciousLabel = 'evil\n<!-- kit:body-end -->\nafter';
        const tampered = readFileSync(filePath, 'utf-8').replace(
          'label: SAFE_PLACEHOLDER_LABEL',
          `label: ${JSON.stringify(maliciousLabel)}`,
        );
        writeFileSync(filePath, tampered, 'utf-8');

        loggerWarnSpy.mockClear();
        // Force a rewrite through an unrelated-field update: `writeRecord` now
        // sanitizes `record.links` unconditionally, before `renderObsidianBody`
        // ever sees them (Wave-3 fast-follow) — so the tampered label is cleaned
        // at the source, not merely defended against at render.
        await adapter.update(
          sourceId,
          { tags: ['retagged'] },
          { agent: 'agent-1' },
        );

        const rewritten = readFileSync(filePath, 'utf-8');
        expect(rewritten).toContain(heading);
        // No line in the rewritten file is a bare, line-exact sentinel other than the
        // one real one immediately after the body.
        const sentinelLines = rewritten
          .split('\n')
          .filter((line) => line === '<!-- kit:body-end -->');
        expect(sentinelLines).toHaveLength(1);
        // The label was sanitized at the source (collapsed to a single line) — no
        // backtick-neutralization is needed because the danger never reached the
        // renderer in the first place.
        expect(rewritten).not.toContain('`<!-- kit:body-end -->`');
        expect(rewritten).toContain('evil <!-- kit:body-end --> after');
        expect(loggerWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining('embedded line break'),
          expect.objectContaining({
            original: maliciousLabel,
            sanitized: 'evil <!-- kit:body-end --> after',
          }),
        );

        // Most importantly: the record's own body is never corrupted by a spurious
        // sentinel match inside a generated section.
        const record = await adapter.get(sourceId);
        expect(record?.body).toBe(originalBody);
        const cleanedLink = record?.links?.find(
          (l) => l.target_id === targetId,
        );
        expect(cleanedLink?.label).toBe('evil <!-- kit:body-end --> after');
      },
    );
  });

  // M1 (Wave-2 code review iteration 4): `extractUnrecognizedTrailingContent` must
  // never silently discard hand-authored content just because its heading text
  // matches one of the four generated-section prefixes — only a record that actually
  // carries links of the corresponding kind could ever have had that section
  // generated by Station.
  describe('M1 fix (Wave-2 code review iteration 4): data-preserving unrecognized-section handling', () => {
    test('a record with zero source links whose file carries a hand-authored ## Sources heading preserves that content into the body and warns, instead of silently discarding it', async () => {
      const id = await adapter.create({
        type: 'concept',
        title: 'No source links at all',
        body: 'Original body.',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });

      const filePath = findObsidianRecordFilePath(dir, id);
      const raw = readFileSync(filePath, 'utf-8');
      const handAuthored =
        '## Sources\n\nMy own manually curated bookmark list, not adapter-generated.';
      writeFileSync(filePath, `${raw}\n\n${handAuthored}`, 'utf-8');

      loggerWarnSpy.mockClear();
      const record = await adapter.get(id);
      expect(record?.body).toBe(`Original body.\n\n${handAuthored}`);
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'hand-authored heading matching a generated-section prefix',
        ),
        expect.objectContaining({ id, heading: '## Sources' }),
      );
    });

    test('a record that DOES carry a matching source link still has its genuinely Station-generated ## Sources section discarded silently (no regression)', async () => {
      const targetId = await adapter.create({
        type: 'concept',
        title: 'Real source',
        body: 'source body',
        category: 'engineering',
        provenance: { agent: 'agent-1' },
      });
      const id = await adapter.create({
        type: 'concept',
        title: 'Has a real source link',
        body: 'Original body.',
        category: 'engineering',
        links: [{ target_id: targetId, kind: 'source' }],
        provenance: { agent: 'agent-1' },
      });

      loggerWarnSpy.mockClear();
      const record = await adapter.get(id);
      expect(record?.body).toBe('Original body.');
      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });
  });

  // Wave-3 fast-follow (code-review new finding, Wave 2 review pass 4): closes the
  // gap where label sanitization only fired on link-touching mutations (via
  // `appendUniqueLinks`), so a metadata-only mutation (e.g. `retire()`, which
  // spreads `...record` untouched) would carry forward an already-bad, legacy/
  // externally-authored `KitLink.label` on disk indefinitely instead of ever
  // cleaning it up at rest -- and would keep re-triggering
  // `neutralizeSentinelShapedLines`'s warning on every future write. `writeRecord`
  // now sanitizes unconditionally on every persisted write.
  test('a legacy newline-label already on disk is sanitized on the very next write, even through a metadata-only mutation (retire) that never touches links itself', async () => {
    const targetId = await adapter.create({
      type: 'concept',
      title: 'Link target',
      body: 'target body',
      category: 'engineering',
      provenance: { agent: 'agent-1' },
    });
    const sourceId = await adapter.create({
      type: 'concept',
      title: 'Legacy label source',
      body: 'Original body.',
      category: 'engineering',
      links: [
        {
          target_id: targetId,
          kind: 'related',
          label: 'SAFE_PLACEHOLDER_LABEL',
        },
      ],
      provenance: { agent: 'agent-1' },
    });

    // Hand-tamper the on-disk frontmatter to simulate a legacy/externally-authored
    // record whose label predates write-time sanitization -- same fixture
    // technique as the H1 sentinel-collision tests above, but WITHOUT placing the
    // sentinel string itself on its own line, so this test is purely about label
    // persistence/cleanliness, not sentinel-corruption defense.
    const filePath = findObsidianRecordFilePath(dir, sourceId);
    const maliciousLabel = 'evil\nlabel\nwith\nnewlines';
    const tampered = readFileSync(filePath, 'utf-8').replace(
      'label: SAFE_PLACEHOLDER_LABEL',
      `label: ${JSON.stringify(maliciousLabel)}`,
    );
    writeFileSync(filePath, tampered, 'utf-8');

    // Confirm the tamper actually landed with a real embedded newline before
    // exercising the fix (otherwise this test would pass vacuously).
    const beforeRaw = readFileSync(filePath, 'utf-8');
    expect(beforeRaw).toContain(JSON.stringify(maliciousLabel));

    loggerWarnSpy.mockClear();
    // retire() is a metadata-only mutation: it spreads `...record` (including the
    // tampered, unsanitized `links`) untouched except for `status`/`updated_at`/
    // `mutation_log` -- it never calls `appendUniqueLinks`/`mergeLinks` itself.
    await adapter.retire(sourceId, 'retired', {
      agent: 'agent-1',
      rationale: 'no longer relevant',
    });

    const afterRaw = readFileSync(filePath, 'utf-8');
    expect(afterRaw).toContain('status: retired');
    expect(afterRaw).not.toContain(maliciousLabel);
    expect(afterRaw).toContain('evil label with newlines');
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('embedded line break'),
      expect.objectContaining({
        original: maliciousLabel,
        sanitized: 'evil label with newlines',
      }),
    );

    // The record's public shape reflects the same sanitized label -- not merely
    // the on-disk bytes.
    const record = await adapter.get(sourceId);
    expect(record?.links?.[0].label).toBe('evil label with newlines');
  });

  test('graph-index.json is present at the store root per §5.1 (required regardless of vault layout)', async () => {
    const a = await adapter.create({
      type: 'raw',
      title: 'A',
      body: 'a',
      category: 'engineering',
      provenance: { agent: 'agent-1' },
    });
    const b = await adapter.create({
      type: 'compiled',
      title: 'B',
      body: 'b',
      category: 'engineering',
      links: [{ target_id: a, kind: 'source' }],
      provenance: { agent: 'agent-1' },
    });

    const graphPath = join(dir, 'graph-index.json');
    expect(existsSync(graphPath)).toBe(true);
    const graph = JSON.parse(readFileSync(graphPath, 'utf-8'));
    expect(graph).toMatchObject({
      schema_version: '1.0',
      forward: { [b]: [{ target_id: a, kind: 'source' }] },
      reverse: { [a]: [{ source_id: b, kind: 'source' }] },
    });
  });
});

describe('kitObsidianStoreAdapterDescriptor.validateRoot — K4 onboarding hook', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kit-obsidian-validate-root-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a missing path is ok:false with a named reason', async () => {
    const result = await kitObsidianStoreAdapterDescriptor.validateRoot?.(
      join(dir, 'does-not-exist'),
    );
    expect(result).toEqual({ ok: false, reason: expect.any(String) });
  });

  test('an empty directory with no .obsidian/ marker is ok:false (garbage/not-yet-a-vault)', async () => {
    const result = await kitObsidianStoreAdapterDescriptor.validateRoot?.(dir);
    expect(result).toEqual({ ok: false, reason: expect.any(String) });
  });

  test('a directory containing a .obsidian/ folder is ok:true', async () => {
    mkdirSync(join(dir, '.obsidian'), { recursive: true });
    const result = await kitObsidianStoreAdapterDescriptor.validateRoot?.(dir);
    expect(result).toEqual({ ok: true });
  });

  test('a non-empty directory without .obsidian/ (a vault never opened in the app yet) is ok:true', async () => {
    writeFileSync(join(dir, 'note.md'), '# hello', 'utf-8');
    const result = await kitObsidianStoreAdapterDescriptor.validateRoot?.(dir);
    expect(result).toEqual({ ok: true });
  });

  test('a path that is a file, not a directory, is ok:false', async () => {
    const filePath = join(dir, 'not-a-dir');
    writeFileSync(filePath, 'x', 'utf-8');
    const result =
      await kitObsidianStoreAdapterDescriptor.validateRoot?.(filePath);
    expect(result).toEqual({ ok: false, reason: expect.any(String) });
  });
});
