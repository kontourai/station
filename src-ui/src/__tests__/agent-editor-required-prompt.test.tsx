/** @vitest-environment jsdom */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { AgentEditorPromptTab } from '../views/agent-editor/AgentEditorPromptTab';
import {
  createEmptyAgentForm,
  createIsBlocked,
  validateAgentForm,
} from '../views/agent-editor/agentsViewUtils';

/**
 * archive#3741: Create refused with "System prompt is required" for the one
 * field on the form that carried no required marker, rendered on a section the
 * person pressing Create was not looking at. §4 had already removed that shape
 * for the ENGINE question; the prompt half was not covered.
 */
function promptTabMarkup(promptIsRequired: boolean, prompt = ''): string {
  return renderToStaticMarkup(
    createElement(AgentEditorPromptTab, {
      form: { ...createEmptyAgentForm(), name: 'Helper', prompt },
      setForm: () => {},
      locked: false,
      validationErrors: {},
      enrich: async () => null,
      isEnriching: false,
      promptIsRequired,
    } as never),
  );
}

describe('agent editor required system prompt', () => {
  test('the field is marked required when the engine needs one', () => {
    const markup = promptTabMarkup(true);
    expect(markup).toContain('editor-required');
    expect(markup).toContain('aria-required="true"');
  });

  test('and is not marked when the engine delivers its own', () => {
    const markup = promptTabMarkup(false);
    expect(markup).not.toContain('editor-required');
    expect(markup).not.toContain('aria-required="true"');
  });

  // The defect itself: a ready engine was enough to make Create pressable, so
  // the missing prompt could only be discovered by pressing it.
  test('Create is blocked while a required field is empty', () => {
    const form = { ...createEmptyAgentForm(), name: 'Helper', slug: 'helper' };
    const missingPrompt = validateAgentForm(form, true, {
      requiresPrompt: true,
    });
    expect(
      createIsBlocked({
        isCreating: true,
        engineReady: true,
        formErrors: missingPrompt,
      }),
    ).toBe(true);

    const complete = validateAgentForm(
      { ...form, prompt: 'Be helpful.' },
      true,
      {
        requiresPrompt: true,
      },
    );
    expect(complete).toEqual({});
    expect(
      createIsBlocked({
        isCreating: true,
        engineReady: true,
        formErrors: complete,
      }),
    ).toBe(false);
  });

  test('an unready engine still blocks a complete form', () => {
    expect(
      createIsBlocked({ isCreating: true, engineReady: false, formErrors: {} }),
    ).toBe(true);
  });

  // Editing a saved agent keeps Save pressable: its validation is the save's,
  // not a gate on a button that says "Create".
  test('editing an existing agent is never blocked by this gate', () => {
    expect(
      createIsBlocked({
        isCreating: false,
        engineReady: false,
        formErrors: { prompt: 'System prompt is required' },
      }),
    ).toBe(false);
  });
});
