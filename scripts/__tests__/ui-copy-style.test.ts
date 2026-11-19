import { describe, expect, it } from 'vitest';
import {
  FILLER,
  inspectUiCopyStyle,
  JARGON,
  styleKinds,
  titleDuplicates,
} from '../ui-copy-style.mjs';

const kinds = (source: string, file = 'src-ui/src/View.tsx') =>
  inspectUiCopyStyle(file, source).map(({ kind }) => kind);

describe('UI copy style policy', () => {
  it('pins the retired vocabulary independently of the script', () => {
    // A literal list: deleting a word from JARGON must fail here, not pass
    // because a derived expectation shrank with it.
    expect(Object.keys(JARGON)).toEqual([
      'authority',
      'admitted',
      'projection',
      'receipt',
      'reconcile',
      'converge',
      'durable',
      're-anchor',
      'legacy',
      'interim',
      'canonical',
      'seam',
      'lease',
      'custody',
      'enrolled',
      'terminal state',
      'binding',
    ]);
    expect(FILLER).toHaveLength(9);
  });

  it('catches each jargon word in its common forms', () => {
    for (const [text, word] of [
      ['Station is the authority for this run.', 'authority'],
      ['An authoritative copy is kept.', 'authority'],
      ['The request was admitted.', 'admitted'],
      ['The projection is stale.', 'projection'],
      ['Open the receipt', 'receipt'],
      ['Receipts are kept for 30 days.', 'receipt'],
      ['Reconciling your changes', 'reconcile'],
      ['Reconciliation failed.', 'reconcile'],
      ['The devices converged.', 'converge'],
      ['Saved to durable history.', 'durable'],
      ['Re-anchored the view.', 're-anchor'],
      ['Legacy', 'legacy'],
      ['Interim search', 'interim'],
      ['The canonical copy', 'canonical'],
      ['Crossed a seam', 'seam'],
      ['The lease expired.', 'lease'],
      ['Chain of custody', 'custody'],
      ['Enrolled sources', 'enrolled'],
      ['Relay enrollment failed.', 'enrolled'],
      ['The run reached a terminal state.', 'terminal state'],
      ['The engine binding is unavailable.', 'binding'],
    ] as const) {
      expect(styleKinds(text), text).toContain(`jargon:${word}`);
    }
  });

  it('does not read "release", key bindings or near words as jargon', () => {
    for (const text of [
      'Download the release',
      'Released yesterday',
      'Keyboard binding',
      'Edit key bindings',
      'Shortcut binding saved',
      'Station admits it.',
      'Authorize this device',
      'Terminal',
      'Open a terminal',
      'Pleased to meet you',
      'Unlock your keychain, then try again.',
      'Hoops and loops',
    ]) {
      expect(styleKinds(text), text).toEqual([]);
    }
  });

  it('catches issue numbers, filler, not-just, ASCII ellipses, emoji and em-dash asides', () => {
    expect(styleKinds('Fixed in station#1234.')).toEqual(['issue-ref']);
    expect(styleKinds('Moved from archive#55.')).toEqual(['issue-ref']);
    expect(styleKinds('See #4690 for details.')).toEqual(['issue-ref']);
    expect(styleKinds('Background #000000')).toEqual([]);
    expect(styleKinds('Item #12')).toEqual([]);
    for (const text of [
      "Let's connect your engine",
      'Simply paste the key.',
      'A seamless handoff',
      'Effortlessly sync',
      'Oops, that failed.',
      'Whoops',
      'Supercharge your work',
      'Unlock the full workspace',
      'Please try again.',
      'Saved!',
      'Done! Next step',
    ]) {
      expect(styleKinds(text), text).toEqual(['filler']);
    }
    expect(styleKinds('if (a != b)')).toEqual([]);
    expect(styleKinds('color: red !important')).toEqual([]);
    expect(styleKinds('It is not just a chat.')).toEqual(['not-just']);
    expect(styleKinds('Not only fast')).toEqual(['not-just']);
    expect(styleKinds('Loading...')).toEqual(['ascii-ellipsis']);
    expect(styleKinds('Loading…')).toEqual([]);
    expect(styleKinds('🏆 Milestones')).toEqual(['emoji']);
    expect(styleKinds('Done ✔')).toEqual(['emoji']);
    for (const text of ['© Kontour', 'Station™', '← Back', '▶ Details', '✓'])
      expect(styleKinds(text), text).toEqual([]);
    expect(styleKinds('Saved — it syncs later')).toEqual(['em-dash']);
    expect(styleKinds('Saved—later')).toEqual([]);
    expect(styleKinds('2–4 devices')).toEqual([]);
  });

  it('reads copy from JSX text, copy attributes, accessible names, properties and literals', () => {
    expect(kinds('<p>Station reconciled the authority.</p>')).toEqual([
      'jargon:authority',
      'jargon:reconcile',
    ]);
    expect(kinds('<Badge>Legacy</Badge>')).toEqual(['jargon:legacy']);
    expect(kinds('<input placeholder="Search..." />')).toEqual([
      'ascii-ellipsis',
    ]);
    expect(kinds('<button aria-label="Open the receipt">x</button>')).toEqual([
      'jargon:receipt',
    ]);
    expect(kinds('<img alt="Durable history" />')).toEqual(['jargon:durable']);
    expect(kinds('<IconButton ariaLabel="Open the receipt" />')).toEqual([
      'jargon:receipt',
    ]);
    expect(kinds("const a = { 'aria-label': 'Legacy' };")).toEqual([
      'jargon:legacy',
    ]);
    expect(
      kinds("const a = { ariaLabel: busy ? 'Saving...' : 'Save' };"),
    ).toEqual(['ascii-ellipsis']);
    // Known gap, pinned so a change is deliberate: a single-word literal
    // outside copy slots is not read.
    expect(kinds("const label = 'Legacy';")).toEqual([]);
    expect(kinds("const steps = [{ label: 'Legacy' }];")).toEqual([
      'jargon:legacy',
    ]);
    expect(kinds("toast.error('The lease expired.');")).toEqual([
      'jargon:lease',
    ]);
    expect(kinds("throw new Error('Relay enrollment failed.');")).toEqual([
      'jargon:enrolled',
    ]);
    expect(kinds("<p>{busy ? 'Saving...' : 'Save'}</p>")).toEqual([
      'ascii-ellipsis',
    ]);
  });

  it('ignores comments, identifiers, class names, code, logs and styling', () => {
    for (const source of [
      '// Station reconciled the authority.\nconst x = <p>Saved.</p>;',
      '{/* legacy receipt projection */}<p>Saved.</p>',
      'const legacyAuthority = receiptProjection;',
      "const mode = 'legacy';",
      "type Kind = 'durable' | 'lease';",
      '<div className="legacy-receipt projection authority" />',
      '<p>Run <code>station reconcile --legacy</code></p>',
      '<pre>durable receipt...</pre>',
      '<kbd>Ctrl...</kbd>',
      "console.warn('legacy receipt reconciled...');",
      "logger.info('authority lease converged');",
      "if (kind === 'terminal state') go();",
      '<span data-state="legacy authority" />',
      "import x from 'legacy receipt';",
    ]) {
      expect(kinds(source), source).toEqual([]);
    }
  });

  it('flags a literal title that repeats its own visible text, and nothing else', () => {
    expect(
      titleDuplicates('src-ui/src/Z.tsx', '<button title="Save">Save</button>'),
    ).toEqual(['Save']);
    expect(
      titleDuplicates(
        'src-ui/src/Z.tsx',
        '<button title="Zoom in">\n  Zoom <strong>in</strong>\n</button>',
      ),
    ).toEqual(['Zoom in']);
    for (const source of [
      // Icon-only: the tooltip is the only hover hint for the name.
      '<IconButton title="Zoom in" aria-label="Zoom in" />',
      '<button title="Zoom in" aria-label="Zoom in"><ZoomIcon /></button>',
      '<button title="Zoom in"><ZoomIcon /></button>',
      '<button title="Zoom in (Ctrl +)">Zoom in</button>',
      '<button title={label}>{label}</button>',
      '<span title="">{name}</span>',
    ]) {
      expect(titleDuplicates('src-ui/src/Z.tsx', source), source).toEqual([]);
    }
    expect(
      kinds('<button title="Save">Save</button>').filter(
        (kind) => kind === 'title-dup',
      ),
    ).toHaveLength(1);
  });
});
