import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const indexCss = readFileSync(
  join(process.cwd(), 'src-ui/src/index.css'),
  'utf8',
);
const chatCss = readFileSync(
  join(process.cwd(), 'src-ui/src/components/chat/chat.css'),
  'utf8',
);

describe('composer Agent/Model controls layout', () => {
  test('model capability filters retain padded non-shrinking hit areas', () => {
    const pickerCss = readFileSync(
      join(
        process.cwd(),
        'src-ui/src/components/session/SessionModelPicker.css',
      ),
      'utf8',
    );
    const rule = pickerCss.match(
      /\.session-model-picker__filters button\s*\{([^}]*)\}/,
    )?.[1];
    expect(rule).toMatch(/padding:\s*0 var\(--space-2\)/);
    expect(rule).toMatch(/flex:\s*none/);
    expect(rule).toMatch(/min-height:\s*32px/);
  });
  test('uses the capsule gutter for the control rail', () => {
    expect(indexCss).toMatch(
      /\.chat-input__meta\s*\{[^}]*padding-inline:\s*var\(--space-2\)/s,
    );
  });

  test('wraps Agent, Model, and approval controls within the narrow-width rail', () => {
    expect(chatCss).toMatch(
      /\.chat-input__meta\s*\{\s*flex-wrap:\s*wrap;\s*overflow-x:\s*visible;/s,
    );
    expect(chatCss).toMatch(
      /\.chat-input__meta\s+\.chat-input__agent-btn,[\s\S]*?\.chat-input__approval-chip\s*\{\s*flex:\s*1\s+1\s+12rem;/s,
    );
    expect(chatCss).toMatch(
      /\.chat-input__meta\s+\.chat-input__agent-btn\s*\{\s*min-width:\s*44px;\s*min-height:\s*44px;/s,
    );
  });
});
