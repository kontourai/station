import { describe, expect, it } from 'vitest';
import {
  findDirtyStateDeclarations,
  findMissingGuardImports,
  runEditorMembershipCheck,
  scanForBannedConfirmPrompt,
} from '../unsaved-guard-gate.mjs';

function readFileFromMap(files: Record<string, string>) {
  return (file: string) => {
    if (!(file in files)) {
      throw new Error(`unexpected read: ${file}`);
    }
    return files[file];
  };
}

describe('unsaved-guard-gate', () => {
  describe('scanForBannedConfirmPrompt', () => {
    it.each([
      "if (confirm('Clear all?')) {}",
      "const x = prompt('Name?');",
      "window.confirm('Clear all?')",
      "window.prompt('Name?')",
    ])('flags the native dialog call in %s', (source) => {
      expect(scanForBannedConfirmPrompt('Example.tsx', source)).toHaveLength(1);
    });

    it.each([
      'onConfirm(id)',
      'confirmLabel="Discard"',
      '<ConfirmModal isOpen />',
      '<PromptModal isOpen />',
      // A differently-named local confirm-like function.
      'showConfirm(true)',
      // A method named confirm() on an unrelated object is not a bare global
      // call; the `.` exclusion leaves it alone.
      'dialog.confirm()',
    ])('leaves %s alone', (source) => {
      expect(scanForBannedConfirmPrompt('Example.tsx', source)).toEqual([]);
    });

    it('flags a bare confirm( call with file/line/snippet', () => {
      const source =
        "export function f() {\n  if (confirm('Clear all?')) {}\n}\n";
      const findings = scanForBannedConfirmPrompt('Example.tsx', source);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ file: 'Example.tsx', line: 2 });
      expect(findings[0].snippet).toContain("confirm('Clear all?')");
    });

    it('flags window.confirm( separately from the bare pattern without double-counting', () => {
      const source = "window.confirm('Clear all?');\n";
      const findings = scanForBannedConfirmPrompt('Example.ts', source);
      expect(findings).toHaveLength(1);
    });
  });

  describe('findMissingGuardImports', () => {
    it('fails naming the file when a known editor is missing the import', () => {
      const files = {
        'a.tsx': "import { useUnsavedGuard } from '../hooks/useUnsavedGuard';",
        'b.tsx': "import { useState } from 'react';",
      };
      const missing = findMissingGuardImports(
        ['a.tsx', 'b.tsx'],
        readFileFromMap(files),
      );
      expect(missing).toEqual(['b.tsx']);
    });

    it('finds nothing missing when every known editor imports the hook', () => {
      const files = {
        'a.tsx': "import { useUnsavedGuard } from '../hooks/useUnsavedGuard';",
        // A multi-named import still counts.
        'b.tsx':
          "import { useState, useUnsavedGuard } from '../hooks/useUnsavedGuard';",
      };
      const missing = findMissingGuardImports(
        ['a.tsx', 'b.tsx'],
        readFileFromMap(files),
      );
      expect(missing).toHaveLength(0);
    });
  });

  describe('findDirtyStateDeclarations', () => {
    it.each([
      'const dirty = a !== b;',
      'const [dirty, setDirty] = useState(false);',
      'const isDirty = a !== b;',
      'const hasChanges = a !== b;',
      'const hasUnsavedChanges = a !== b;',
    ])('flags the declaration shape %s', (source) => {
      expect(
        findDirtyStateDeclarations(
          ['Editor.tsx'],
          readFileFromMap({ 'Editor.tsx': source }),
        ),
      ).toEqual(['Editor.tsx']);
    });

    it('ignores fixture files with only a bare dirty param or CSS class string', () => {
      const files = {
        'src-ui/src/main.tsx':
          'sanitize(html, { dirty: true });\nexport const x = 1;',
        'src-ui/src/views/ProjectPage.tsx':
          'export const cls = "project-page__git-section-dirty";',
      };
      const matches = findDirtyStateDeclarations(
        Object.keys(files),
        readFileFromMap(files),
      );
      expect(matches).toHaveLength(0);
    });
  });

  describe('runEditorMembershipCheck', () => {
    it('passes clean when every known editor imports the hook and no untriaged findings exist', () => {
      const knownEditors = ['a.tsx'];
      const files: Record<string, string> = {
        'a.tsx':
          "import { useUnsavedGuard } from '../hooks/useUnsavedGuard';\nconst dirty = true;",
      };
      const result = runEditorMembershipCheck({
        knownEditors,
        exclusions: [],
        candidateFiles: ['a.tsx'],
        readFile: readFileFromMap(files),
      });
      expect(result.missingImports).toHaveLength(0);
      expect(result.untriagedFindings).toHaveLength(0);
      expect(result.staleExclusions).toHaveLength(0);
    });

    it('flags an untriaged finding for a new dirty-state file outside the known list and exclusions', () => {
      const files: Record<string, string> = {
        'known.tsx':
          "import { useUnsavedGuard } from '../hooks/useUnsavedGuard';\nconst dirty = true;",
        'new-editor.tsx': 'const isDirty = a !== b;',
      };
      const result = runEditorMembershipCheck({
        knownEditors: ['known.tsx'],
        exclusions: [],
        candidateFiles: ['known.tsx', 'new-editor.tsx'],
        readFile: readFileFromMap(files),
      });
      expect(result.untriagedFindings).toEqual(['new-editor.tsx']);
    });

    it('does not flag a heuristic match that is covered by an exclusion entry', () => {
      const files: Record<string, string> = {
        'excluded.tsx': 'const hasChanges = detectChanges();',
      };
      const result = runEditorMembershipCheck({
        knownEditors: [],
        exclusions: ['excluded.tsx'],
        candidateFiles: ['excluded.tsx'],
        readFile: readFileFromMap(files),
      });
      expect(result.untriagedFindings).toHaveLength(0);
      expect(result.staleExclusions).toHaveLength(0);
    });

    it('fails on a stale exclusion entry that no longer matches any heuristic finding', () => {
      const files: Record<string, string> = {
        'no-longer-dirty.tsx': 'export const x = 1;',
      };
      const result = runEditorMembershipCheck({
        knownEditors: [],
        exclusions: ['no-longer-dirty.tsx'],
        candidateFiles: ['no-longer-dirty.tsx'],
        readFile: readFileFromMap(files),
      });
      expect(result.staleExclusions).toEqual(['no-longer-dirty.tsx']);
    });
  });
});
