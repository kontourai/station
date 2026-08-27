/** @vitest-environment jsdom */

import { SKILL_COMMAND_NAME_RULE } from '@kontourai/station-contracts/skill-command';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { SkillCommandSection } from '../views/skills/SkillCommandSection';
import { EMPTY_SKILL_FORM } from '../views/skills/skill-view-utils';

/**
 * station#3737: `PUT /api/skills/<name>` refused `Ship It` with the rule it
 * broke, nothing reached the screen, and the field went on promising
 * "Type /Ship It in chat." — a command that does not exist and cannot be
 * typed.
 */
function markupFor(commandName: string): string {
  return renderToStaticMarkup(
    createElement(SkillCommandSection, {
      form: {
        ...EMPTY_SKILL_FORM,
        name: 'Ship it',
        commandEnabled: true,
        commandName,
      },
      editable: true,
      onChange: () => {},
    } as never),
  );
}

describe('skill command word', () => {
  test('a refused word is refused at the field, in the rule it broke', () => {
    const markup = markupFor('Ship It');
    // Rendered markup escapes the rule's quotes, so match its distinctive
    // clause rather than the raw sentence.
    expect(SKILL_COMMAND_NAME_RULE).toContain(
      'lowercase letters, digits and dashes',
    );
    expect(markup).toContain('lowercase letters, digits and dashes');
    expect(markup).not.toContain('/Ship It');
    expect(markup).not.toContain('in chat.');
  });

  test('a word the server will accept is advertised', () => {
    const markup = markupFor('ship-it');
    expect(markup).toContain('/ship-it');
    expect(markup).toContain('in chat.');
    expect(markup).not.toContain('lowercase letters, digits and dashes');
  });
});
