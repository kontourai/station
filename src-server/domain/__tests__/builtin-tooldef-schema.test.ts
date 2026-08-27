import { describe, expect, test } from 'vitest';
import {
  createBuiltinVendedToolDef,
  listBuiltinVendedRegistryItems,
} from '../../runtime/tools/vended-tool-compat.js';
import { validator } from '../validator.js';

// Regression guard: every builtin vended tool must produce a ToolDef that
// passes the tool JSON-schema, because installing one writes it via
// configLoader.saveIntegration → validator.validateToolDef. A stale
// builtinPolicy.name enum in schemas/tool.schema.json silently made ALL
// builtin vended tools un-installable (and therefore un-referenceable by an
// agent). Surfaced by dogfooding render_component end to end.

describe('builtin vended tool defs validate against the tool schema', () => {
  const ids = listBuiltinVendedRegistryItems().map((i) => i.id);

  test('there is at least one builtin', () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  test.each(ids)(
    'createBuiltinVendedToolDef(%s) passes validateToolDef',
    (id) => {
      const def = createBuiltinVendedToolDef(id);
      expect(def).not.toBeNull();
      // Throws ValidationError if the schema rejects it (e.g. a stale
      // builtinPolicy.name enum) — the bug this test locks out.
      expect(() => validator.validateToolDef(def)).not.toThrow();
    },
  );
});
