import { describe, expect, it } from 'vitest';
import {
  BARE_CONFIRM_PROMPT_PATTERN,
  DIRTY_STATE_DECLARATION_PATTERN,
  findDirtyStateDeclarations,
  findMissingGuardImports,
  KNOWN_DIRTY_STATE_EDITORS,
  runEditorMembershipCheck,
  scanForBannedConfirmPrompt,
  USE_UNSAVED_GUARD_IMPORT_PATTERN,
  WINDOW_CONFIRM_PROMPT_PATTERN,
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
  describe('BARE_CONFIRM_PROMPT_PATTERN / WINDOW_CONFIRM_PROMPT_PATTERN', () => {
    it('matches bare confirm( and prompt(', () => {
      expect(
        "if (confirm('Clear all?')) {}".match(BARE_CONFIRM_PROMPT_PATTERN),
      ).not.toBeNull();
      expect(
        "const x = prompt('Name?');".match(BARE_CONFIRM_PROMPT_PATTERN),
      ).not.toBeNull();
    });

    it('matches window.confirm( and window.prompt(', () => {
      expect(
        "window.confirm('Clear all?')".match(WINDOW_CONFIRM_PROMPT_PATTERN),
      ).not.toBeNull();
      expect(
        "window.prompt('Name?')".match(WINDOW_CONFIRM_PROMPT_PATTERN),
      ).not.toBeNull();
    });

    it('does not match onConfirm(, confirmLabel, ConfirmModal, or PromptModal', () => {
      BARE_CONFIRM_PROMPT_PATTERN.lastIndex = 0;
      expect(BARE_CONFIRM_PROMPT_PATTERN.test('onConfirm(id)')).toBe(false);
      BARE_CONFIRM_PROMPT_PATTERN.lastIndex = 0;
      expect(BARE_CONFIRM_PROMPT_PATTERN.test('confirmLabel="Discard"')).toBe(
        false,
      );
      BARE_CONFIRM_PROMPT_PATTERN.lastIndex = 0;
      expect(BARE_CONFIRM_PROMPT_PATTERN.test('<ConfirmModal isOpen />')).toBe(
        false,
      );
      BARE_CONFIRM_PROMPT_PATTERN.lastIndex = 0;
      expect(BARE_CONFIRM_PROMPT_PATTERN.test('<PromptModal isOpen />')).toBe(
        false,
      );
    });

    it('does not match a differently-named local confirm-like function call', () => {
      BARE_CONFIRM_PROMPT_PATTERN.lastIndex = 0;
      expect(BARE_CONFIRM_PROMPT_PATTERN.test('showConfirm(true)')).toBe(false);
      BARE_CONFIRM_PROMPT_PATTERN.lastIndex = 0;
      // A method named confirm() on some unrelated object is not a bare
      // global call — the gate does not chase down every possible false
      // positive here (that's what the `.` exclusion buys), but a bare
      // dotted call whose receiver itself is a word character stays excluded.
      expect(BARE_CONFIRM_PROMPT_PATTERN.test('dialog.confirm()')).toBe(false);
    });
  });

  describe('scanForBannedConfirmPrompt', () => {
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

    it('does not flag ConfirmModal usage or a confirmLabel prop', () => {
      const source =
        'export function f() {\n' +
        '  return <ConfirmModal isOpen confirmLabel="Discard" onConfirm={onConfirm} />;\n' +
        '}\n';
      const findings = scanForBannedConfirmPrompt('Example.tsx', source);
      expect(findings).toHaveLength(0);
    });
  });

  describe('DIRTY_STATE_DECLARATION_PATTERN', () => {
    it('matches known declaration shapes', () => {
      expect(DIRTY_STATE_DECLARATION_PATTERN.test('const dirty =')).toBe(true);
      expect(
        DIRTY_STATE_DECLARATION_PATTERN.test('const [dirty, setDirty]'),
      ).toBe(true);
      expect(DIRTY_STATE_DECLARATION_PATTERN.test('const isDirty =')).toBe(
        true,
      );
      expect(DIRTY_STATE_DECLARATION_PATTERN.test('const hasChanges =')).toBe(
        true,
      );
      expect(
        DIRTY_STATE_DECLARATION_PATTERN.test('const hasUnsavedChanges ='),
      ).toBe(true);
    });

    it('ignores a bare non-declaration `dirty` param and a CSS-class-name string (fixture strings, not live files)', () => {
      // main.tsx-style DOMPurify config param.
      expect(
        DIRTY_STATE_DECLARATION_PATTERN.test('sanitize(html, { dirty: true })'),
      ).toBe(false);
      // ProjectPage.tsx-style CSS class name.
      expect(
        DIRTY_STATE_DECLARATION_PATTERN.test(
          'className="project-page__git-section-dirty"',
        ),
      ).toBe(false);
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
      };
      const missing = findMissingGuardImports(
        ['a.tsx'],
        readFileFromMap(files),
      );
      expect(missing).toHaveLength(0);
    });
  });

  describe('USE_UNSAVED_GUARD_IMPORT_PATTERN', () => {
    it('matches a multi-named import that includes useUnsavedGuard', () => {
      expect(
        USE_UNSAVED_GUARD_IMPORT_PATTERN.test(
          "import { useState, useUnsavedGuard } from '../hooks/useUnsavedGuard';",
        ),
      ).toBe(true);
    });
  });

  describe('findDirtyStateDeclarations', () => {
    it('flags a synthetic dirty-state declaration outside the known list', () => {
      const files = {
        'src-ui/src/views/SyntheticEditor.tsx':
          'const isDirty = a !== b;\nexport function X() { return isDirty; }',
      };
      const matches = findDirtyStateDeclarations(
        ['src-ui/src/views/SyntheticEditor.tsx'],
        readFileFromMap(files),
      );
      expect(matches).toEqual(['src-ui/src/views/SyntheticEditor.tsx']);
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

  describe('KNOWN_DIRTY_STATE_EDITORS (repo-source integration)', () => {
    it('lists every confirmed dirty-state editor', () => {
      expect(KNOWN_DIRTY_STATE_EDITORS).toEqual([
        'src-ui/src/views/ProjectSettingsView.tsx',
        'src-ui/src/views/SkillsView.tsx',
        'src-ui/src/views/agent-editor/useAgentsViewModel.ts',
        'src-ui/src/views/KnowledgeConnectionView.tsx',
        'src-ui/src/views/ProviderSettingsView.tsx',
        'src-ui/src/views/SettingsView.tsx',
        'src-ui/src/views/integrations/SecretBindingsSection.tsx',
      ]);
    });
  });
});
