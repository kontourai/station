/** @vitest-environment jsdom */
import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { MarkdownRenderer } from '../components/chat/MarkdownRenderer';

/**
 * Agent output is untrusted input to the renderer: models emit malformed
 * entities, unterminated tags, and surrogate garbage routinely, and a throw
 * here takes the whole message list down with it. Comparable products
 * shipped a crash fix for exactly this class (invalid HTML entities crashing
 * mobile markdown); this pins that ours renders instead of throwing.
 */
const HOSTILE: string[] = [
  'bad entity &#xZZZZ; mid-sentence',
  'overlong numeric &#999999999999; and named &nosuchentity;',
  'lone surrogate \ud800 and replacement � char',
  '<div><span>unclosed nesting',
  '<<<>>>&&&;;;',
  '&#x0;&#x1F600;&#xD800;',
  '![img](javascript:alert(1)) [x](vbscript:x)',
  '```\n&#xNOPE;\n``` inline `&#xBAD;`',
  '| a | b |\n|---|\n| unbalanced table',
];

describe('MarkdownRenderer survives hostile agent output', () => {
  test.each(HOSTILE)('renders without throwing: %s', (input) => {
    expect(() =>
      render(<MarkdownRenderer>{input}</MarkdownRenderer>),
    ).not.toThrow();
  });
});
