import { describe, expect, it } from 'vitest';
import {
  ALREADY_CANONICAL_EXCLUSIONS,
  applyPreShellLoadingExclusions,
  blankComments,
  collectModalFamilies,
  fileHasLiveEmptyClass,
  fileRendersUnguardedEmpty,
  findEmptyFamilyFiles,
  findUnguardedEmptyFiles,
  PRE_SHELL_LOADING_EXCLUSIONS,
  runEmptyFamilyCheck,
  S4_DEFERRED_EXCLUSIONS,
  scanAdHocNoX,
  scanAdHocNoXFile,
  scanBespokeButtonsFile,
  scanFabricatedLoadingFile,
  scanLoadingStrings,
  scanLoadingStringsFile,
  scanUnguardedEmptyFile,
  splitTopLevelChunks,
  TEXT_NODE_PATTERN,
} from '../state-primitives-ratchet.mjs';

function readFileFromMap(files: Record<string, string>) {
  return (file: string) => {
    if (!(file in files)) {
      throw new Error(`unexpected read: ${file}`);
    }
    return files[file];
  };
}

describe('state-primitives-ratchet', () => {
  describe('fileHasLiveEmptyClass', () => {
    it('matches a plain double-quoted className', () => {
      expect(
        fileHasLiveEmptyClass('<div className="command-palette__empty">'),
      ).toBe(true);
    });

    it('matches a template-literal className', () => {
      expect(
        fileHasLiveEmptyClass(
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture deliberately embeds an interpolation
          '<div className={`agent-picker__empty ${extra}`}>',
        ),
      ).toBe(true);
    });

    it('matches a JSX-expression-string className', () => {
      expect(fileHasLiveEmptyClass(`<div className={'plugins__empty'}>`)).toBe(
        true,
      );
    });

    it('does not match a className without an __empty suffix', () => {
      expect(fileHasLiveEmptyClass('<div className="split-pane__item">')).toBe(
        false,
      );
    });

    it('does not match __empty appearing outside a className attribute', () => {
      expect(
        fileHasLiveEmptyClass("const x = 'plugins__empty'; // not a class"),
      ).toBe(false);
    });
  });

  describe('findEmptyFamilyFiles', () => {
    it('returns only files with a live __empty className', () => {
      const files = {
        'a.tsx': '<div className="foo__empty" />',
        'b.tsx': '<div className="foo__item" />',
      };
      expect(
        findEmptyFamilyFiles(Object.keys(files), readFileFromMap(files)),
      ).toEqual(['a.tsx']);
    });
  });

  describe('runEmptyFamilyCheck', () => {
    it('passes clean when live bespoke files are exactly the deferred set, at ceiling', () => {
      const files: Record<string, string> = {
        'canonical.tsx': '<div className="split-pane__empty-icon" />',
        'deferred.tsx': '<div className="connections-hub__empty-card" />',
      };
      const result = runEmptyFamilyCheck({
        files: Object.keys(files),
        readFile: readFileFromMap(files),
        alreadyCanonical: ['canonical.tsx'],
        s4Deferred: ['deferred.tsx'],
        ceiling: 1,
      });
      expect(result.untriaged).toHaveLength(0);
      expect(result.staleDeferred).toHaveLength(0);
      expect(result.staleCanonical).toHaveLength(0);
      expect(result.withinCeiling).toBe(true);
      expect(result.liveBespoke).toEqual(['deferred.tsx']);
    });

    it('flags an untriaged finding for a new bespoke file outside both exclusion lists', () => {
      const files: Record<string, string> = {
        'new-view.tsx': '<div className="new-view__empty" />',
      };
      const result = runEmptyFamilyCheck({
        files: Object.keys(files),
        readFile: readFileFromMap(files),
        alreadyCanonical: [],
        s4Deferred: [],
        ceiling: 4,
      });
      expect(result.untriaged).toEqual(['new-view.tsx']);
    });

    it('fails a stale S4_DEFERRED_EXCLUSIONS entry once the file has been migrated', () => {
      const files: Record<string, string> = {
        'migrated.tsx': '<Empty label="Nothing here" />',
      };
      const result = runEmptyFamilyCheck({
        files: Object.keys(files),
        readFile: readFileFromMap(files),
        alreadyCanonical: [],
        s4Deferred: ['migrated.tsx'],
        ceiling: 4,
      });
      expect(result.staleDeferred).toEqual(['migrated.tsx']);
    });

    it('fails a stale ALREADY_CANONICAL_EXCLUSIONS entry once its __empty class is removed', () => {
      const files: Record<string, string> = {
        'no-longer-empty.tsx': '<div className="split-pane__item" />',
      };
      const result = runEmptyFamilyCheck({
        files: Object.keys(files),
        readFile: readFileFromMap(files),
        alreadyCanonical: ['no-longer-empty.tsx'],
        s4Deferred: [],
        ceiling: 4,
      });
      expect(result.staleCanonical).toEqual(['no-longer-empty.tsx']);
    });

    it('fails ceiling comparison when live bespoke count exceeds it, even with no untriaged files', () => {
      const files: Record<string, string> = {
        'a.tsx': '<div className="a__empty" />',
        'b.tsx': '<div className="b__empty" />',
      };
      const result = runEmptyFamilyCheck({
        files: Object.keys(files),
        readFile: readFileFromMap(files),
        alreadyCanonical: [],
        s4Deferred: ['a.tsx', 'b.tsx'],
        ceiling: 1,
      });
      expect(result.untriaged).toHaveLength(0);
      expect(result.withinCeiling).toBe(false);
    });
  });

  describe('TEXT_NODE_PATTERN', () => {
    it('matches a single-line JSX text node starting with "No "', () => {
      TEXT_NODE_PATTERN.lastIndex = 0;
      expect(TEXT_NODE_PATTERN.test('<span>No matching commands</span>')).toBe(
        true,
      );
    });
  });

  describe('scanAdHocNoXFile', () => {
    it('flags a JSX text node ad-hoc "No X" string', () => {
      const findings = scanAdHocNoXFile(
        'Example.tsx',
        '<div>\n  <span>No matching commands</span>\n</div>\n',
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ file: 'Example.tsx', line: 2 });
    });

    it('flags a known-attribute "No X" string (double-quoted)', () => {
      const findings = scanAdHocNoXFile(
        'Example.tsx',
        '<SplitPaneLayout emptyTitle="No agent selected" />',
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].snippet).toBe('No agent selected');
    });

    it('flags a bare single-quoted default-parameter-style "No X" assignment', () => {
      const findings = scanAdHocNoXFile(
        'Example.tsx',
        "function f({ listEmptyTitle = 'No items yet' }) {}",
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].snippet).toBe('No items yet');
    });

    it('does not double-count two patterns matching the same line', () => {
      const findings = scanAdHocNoXFile(
        'Example.tsx',
        'emptyTitle="No agent selected"',
      );
      expect(findings).toHaveLength(1);
    });

    it('does not flag copy that does not start with "No "', () => {
      const findings = scanAdHocNoXFile(
        'Example.tsx',
        '<SplitPaneLayout emptyTitle="Nothing selected" />',
      );
      expect(findings).toHaveLength(0);
    });
  });

  describe('scanAdHocNoX', () => {
    it('aggregates findings across files', () => {
      const files: Record<string, string> = {
        'a.tsx': '<span>No agents yet</span>',
        'b.tsx': 'emptyTitle="No skill selected"',
      };
      const findings = scanAdHocNoX(Object.keys(files), readFileFromMap(files));
      expect(findings).toHaveLength(2);
    });
  });

  describe('scanLoadingStringsFile (SHELL-13 — one loading vocabulary)', () => {
    it('counts a single-line bespoke loading string', () => {
      const findings = scanLoadingStringsFile(
        'a.tsx',
        '<div className="x">Loading scheduler...</div>',
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].snippet).toContain('Loading scheduler...');
    });

    it('counts the multi-line JSX form the empty-class scan cannot see', () => {
      const findings = scanLoadingStringsFile(
        'a.tsx',
        '<div className="x">\n  Loading notifications…\n</div>',
      );
      expect(findings).toHaveLength(1);
    });

    it('does NOT count a skeleton label — the canonical way a wait names itself', () => {
      expect(
        scanLoadingStringsFile(
          'a.tsx',
          '<SkeletonList count={4} label="Loading notifications" />',
        ),
      ).toHaveLength(0);
    });

    it('skips test files, whose fixture strings are not shipped treatments', () => {
      const files = ['src-ui/src/__tests__/X.test.tsx', 'src-ui/src/X.tsx'];
      const findings = scanLoadingStrings(
        files,
        () => '<p>Loading transcript</p>',
      );
      expect(findings.map((f) => f.file)).toEqual(['src-ui/src/X.tsx']);
    });

    // Review M1 gave the two gaming vectors verbatim. Both are counted now.
    it('counts a wait sentence hoisted out of JSX into a constant', () => {
      const findings = scanLoadingStringsFile(
        'a.tsx',
        "const WAIT_COPY = 'Loading notifications…';\nreturn <p>{WAIT_COPY}</p>;",
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].snippet).toContain('Loading notifications…');
    });

    it('counts a wait verb the first vocabulary did not know', () => {
      expect(
        scanLoadingStringsFile('a.tsx', '<p>Fetching notifications…</p>'),
      ).toHaveLength(1);
      expect(
        scanLoadingStringsFile(
          'a.tsx',
          '<main>Opening the sample workspace…</main>',
        ),
      ).toHaveLength(1);
      expect(
        scanLoadingStringsFile(
          'a.tsx',
          "<p>{'Negotiating with the cloud...'}</p>",
        ),
      ).toHaveLength(1);
    });

    // A stage NAME in a progress display, and a comment quoting a banned
    // string, are not shipped waits. Both would be false positives.
    it('does not count a bare added verb with no ellipsis, nor a comment', () => {
      expect(
        scanLoadingStringsFile('a.tsx', '<strong>Checking</strong>'),
      ).toHaveLength(0);
      expect(
        scanLoadingStringsFile(
          'a.tsx',
          '// this used to render "Negotiating with the cloud..." here\nreturn null;',
        ),
      ).toHaveLength(0);
      expect(
        scanLoadingStringsFile(
          'a.tsx',
          '/* SHELL-13 removed the "Loading profile..." string */\nreturn null;',
        ),
      ).toHaveLength(0);
    });

    // The shared Button's `pendingLabel` contract: a control that swaps its
    // own label is not a treatment that replaces content.
    it('does not count a pending-label ternary, whichever arm the wait is', () => {
      expect(
        scanLoadingStringsFile(
          'a.tsx',
          "<Button>{isPending ? 'Checking…' : submitLabel}</Button>",
        ),
      ).toHaveLength(0);
      expect(
        scanLoadingStringsFile(
          'a.tsx',
          "<Button>{ready ? 'Check again' : 'Checking…'}</Button>",
        ),
      ).toHaveLength(0);
      expect(
        scanLoadingStringsFile(
          'a.tsx',
          "placeholder={\n  status.isLoading\n    ? 'Checking git status…'\n    : 'Working tree clean'\n}",
        ),
      ).toHaveLength(0);
    });

    it('still counts a wait whose only alternative is nothing at all', () => {
      expect(
        scanLoadingStringsFile(
          'a.tsx',
          "<div>{loading ? 'Loading…' : null}</div>",
        ),
      ).toHaveLength(1);
    });

    it('blankComments preserves offsets so reported line numbers stay true', () => {
      const source = '// "Loading x…"\nconst a = 1;\n<p>Loading y…</p>';
      expect(blankComments(source)).toHaveLength(source.length);
      expect(scanLoadingStringsFile('a.tsx', source)[0].line).toBe(3);
    });

    it('does not blank the // inside a URL literal', () => {
      expect(blankComments("const u = 'https://x/y'; const b = 2;")).toContain(
        'const b = 2;',
      );
    });
  });

  describe('PRE_SHELL_LOADING_EXCLUSIONS', () => {
    // Waits with no shell to keep and no region to skeleton, each named by
    // file AND exact text so none can silently become a free slot for a
    // different sentence in the same file.
    it('names exactly the pre-auth access check and the two published-SDK default waits', () => {
      expect(PRE_SHELL_LOADING_EXCLUSIONS).toEqual([
        {
          file: 'src-ui/src/components/LocalUiSessionGate.tsx',
          text: "Checking this browser's Station access…",
        },
        {
          file: 'packages/sdk/src/components/Loading.tsx',
          text: 'Loading...',
        },
        {
          file: 'packages/sdk/src/components/KnowledgeRecall.tsx',
          text: 'Loading canonical record…',
        },
      ]);
    });

    it('subtracts the named finding and counts every other wait in that file', () => {
      const { counted, stale } = applyPreShellLoadingExclusions([
        {
          file: 'src-ui/src/components/LocalUiSessionGate.tsx',
          line: 87,
          snippet: ">Checking this browser's Station access…<",
        },
        {
          file: 'src-ui/src/components/LocalUiSessionGate.tsx',
          line: 96,
          snippet: '>Opening the sample workspace…<',
        },
        {
          file: 'packages/sdk/src/components/Loading.tsx',
          line: 57,
          snippet: "'Loading...'",
        },
        {
          file: 'packages/sdk/src/components/KnowledgeRecall.tsx',
          line: 438,
          snippet: '>Loading canonical record…<',
        },
      ]);
      expect(counted.map((finding: { line: number }) => finding.line)).toEqual([
        96,
      ]);
      expect(stale).toEqual([]);
    });

    it('fails as stale once the excluded wait is removed or reworded', () => {
      const { stale } = applyPreShellLoadingExclusions([]);
      expect(stale).toEqual(PRE_SHELL_LOADING_EXCLUSIONS);
    });
  });

  describe('scanFabricatedLoadingFile (SHELL-09 — the literal mechanism)', () => {
    it('counts the exact line that made /guidance assert an empty Guidance', () => {
      const findings = scanFabricatedLoadingFile(
        'src-ui/src/views/SkillsView.tsx',
        'const { data } = useSkillsQuery();\nconst isLoading = false;\n',
      );
      expect(findings).toHaveLength(1);
      expect(findings[0].line).toBe(2);
    });

    it('counts a typed or true-valued fabrication too', () => {
      expect(
        scanFabricatedLoadingFile('a.tsx', 'const isPending: boolean = true;'),
      ).toHaveLength(1);
    });

    it('does not count a derived flag', () => {
      expect(
        scanFabricatedLoadingFile(
          'a.tsx',
          'const { isPending: isLoading } = useSkillsQuery();',
        ),
      ).toHaveLength(0);
    });
  });

  describe('fileRendersUnguardedEmpty (SHELL-09 — the general form)', () => {
    it('flags an Empty rendered by a file that reads a query and shows no wait', () => {
      expect(
        fileRendersUnguardedEmpty(
          'const { data = [], isPending } = useThingsQuery();\n' +
            'return data.length === 0 ? <Empty label="Nothing" /> : <List />;',
        ),
      ).toBe(true);
    });

    it('clears a file that renders a skeleton', () => {
      expect(
        fileRendersUnguardedEmpty(
          'const { isPending } = useThingsQuery();\n' +
            'if (isPending) return <SkeletonList />;\n' +
            'return <Empty label="Nothing" />;',
        ),
      ).toBe(false);
    });

    it('clears a file that hands the loading fact to a component that owns the skeleton', () => {
      expect(
        fileRendersUnguardedEmpty(
          'const { isLoading } = useThingsQuery();\n' +
            '<SplitPaneLayout loading={isLoading}><Empty label="x" /></SplitPaneLayout>',
        ),
      ).toBe(false);
    });

    it('does not treat a mutation pending as a read signal', () => {
      // `saveMutation.isPending` is an ACTION in flight; it says nothing about
      // whether the list has been read, so a file whose only "loading" mention
      // is a mutation is not a candidate.
      expect(
        fileRendersUnguardedEmpty(
          'const saveMutation = useSaveMutation();\n' +
            '<button disabled={saveMutation.isPending} />\n<Empty label="x" />',
        ),
      ).toBe(false);
    });

    // Review M1: the file-level form let any skeleton anywhere in a file
    // vouch for every <Empty> in it, regardless of branch relationship.
    it('scanUnguardedEmptyFile flags the component even when a SIBLING renders the skeleton', () => {
      const content = [
        'function ListSkeleton() {',
        '  return <SkeletonList count={3} />;',
        '}',
        '',
        'export function Panel() {',
        '  const { data = [], isPending } = useThingQuery();',
        '  if (isPending) return null;',
        '  return <Empty label="No things yet" />;',
        '}',
      ].join('\n');

      // The whole-file arm is cleared by the sibling skeleton...
      expect(fileRendersUnguardedEmpty(content)).toBe(false);
      // ...and the component-scoped arm is not.
      expect(scanUnguardedEmptyFile('a.tsx', content)).toEqual([
        { file: 'a.tsx', component: 'Panel' },
      ]);
    });

    it('clears a component that renders its own skeleton', () => {
      const content = [
        'export function Panel() {',
        '  const { data = [], isPending } = useThingQuery();',
        '  if (isPending) return <SkeletonList count={3} />;',
        '  return <Empty label="No things yet" />;',
        '}',
      ].join('\n');
      expect(scanUnguardedEmptyFile('a.tsx', content)).toEqual([]);
    });

    // Component scoping alone would be a WEAKENING here — neither chunk trips
    // on its own — so the whole-file arm is kept and the two are unioned.
    it('keeps the whole-file arm when the read and the Empty sit in different components', () => {
      const content = [
        'export function Reader() {',
        '  const { isPending } = useThingQuery();',
        '  return <Rows busy={isPending} />;',
        '}',
        '',
        'export function Rows() {',
        '  return <Empty label="No things yet" />;',
        '}',
      ].join('\n');
      expect(scanUnguardedEmptyFile('a.tsx', content)).toEqual([
        { file: 'a.tsx', component: '<file>' },
      ]);
    });

    it('splitTopLevelChunks names every top-level declaration form', () => {
      const chunks = splitTopLevelChunks(
        'import x from "y";\nfunction A() {}\nexport function B() {}\nconst C = () => null;\n',
      );
      expect(chunks.map((chunk) => chunk.name)).toEqual([
        '<module>',
        'A',
        'B',
        'C',
      ]);
    });

    it('skips test files', () => {
      const content = 'const { isPending } = useQ();\n<Empty label="x" />';
      expect(
        findUnguardedEmptyFiles(
          ['src-ui/src/__tests__/A.test.tsx', 'src-ui/src/B.tsx'],
          () => content,
        ),
      ).toEqual(['src-ui/src/B.tsx']);
    });
  });

  describe('scanBespokeButtonsFile (SHELL-02 — one Button)', () => {
    it('counts an editor-btn and its modifier as separate uses', () => {
      const findings = scanBespokeButtonsFile(
        'a.tsx',
        '<button className="editor-btn editor-btn--primary">Save</button>',
      );
      expect(findings.map((f) => f.snippet)).toEqual([
        'editor-btn',
        'editor-btn--primary',
      ]);
    });

    it('counts the retired page__btn family', () => {
      expect(
        scanBespokeButtonsFile('a.tsx', 'className="page__btn-primary"'),
      ).toHaveLength(1);
    });

    it('does not count the shared Button', () => {
      expect(
        scanBespokeButtonsFile('a.tsx', '<Button variant="primary" />'),
      ).toHaveLength(0);
    });
  });

  describe('collectModalFamilies (SHELL-02 — one Dialog chrome)', () => {
    it('groups every class of one family under one entry', () => {
      const families = collectModalFamilies(
        ['a.tsx'],
        () =>
          '<div className="new-chat-modal__header"><p className="new-chat-modal__body" />',
      );
      expect([...families]).toEqual([['new-chat-modal', 2]]);
    });

    it('separates distinct families', () => {
      const families = collectModalFamilies(
        ['a.tsx'],
        () => 'new-chat-modal__header import-modal__dialog',
      );
      expect([...families.keys()].sort()).toEqual([
        'import-modal',
        'new-chat-modal',
      ]);
    });

    it('does not count the shared station-dialog chrome', () => {
      expect(
        collectModalFamilies(['a.tsx'], () => 'station-dialog__header').size,
      ).toBe(0);
    });
  });

  describe('exclusion lists (repo-source integration)', () => {
    it('ALREADY_CANONICAL_EXCLUSIONS names exactly the already-composing-Empty files that retain bespoke empty classes', () => {
      // NotificationsPage left this list when its only `__empty` class — a
      // "Loading notifications…" div that replaced the entire page — became a
      // SkeletonList under the header (SHELL-13).
      expect(ALREADY_CANONICAL_EXCLUSIONS).toEqual([
        'src-ui/src/components/SplitPaneLayout.tsx',
        'src-ui/src/components/registry/RegistryCatalog.tsx',
      ]);
    });

    it('S4_DEFERRED_EXCLUSIONS is empty: every deferred bespoke empty state has been migrated', () => {
      // Was one entry (project-settings/LayoutsSection.tsx), deferred to #193.
      // #193 closed 2026-07-08 having scoped the shell/skeleton port and never
      // this empty-state migration, so the deferral outlived its owner and
      // pointed at closed work (#3101). The file now renders the canonical
      // Empty primitive, so the list is empty and `emptyFamilyCeiling` is 0.
      //
      // This is the pin that stops a new bespoke empty state being waved
      // through by quietly appending to the exclusion list instead of
      // migrating the view — the gate's own failure text offers that escape
      // hatch, so taking it has to cost a deliberate, reviewable test edit.
      expect(S4_DEFERRED_EXCLUSIONS).toEqual([]);
    });
  });
});
