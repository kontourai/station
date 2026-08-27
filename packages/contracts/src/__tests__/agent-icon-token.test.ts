import { describe, expect, test } from 'vitest';
import {
  AGENT_ICON_TOKEN_MAX_LENGTH,
  agentIconBrandKey,
  isSupportedAgentIconToken,
} from '../agent.js';

describe('Agent icon token contract', () => {
  test.each(['✨', 'sparkles', 'brand:codex', 'brand:opencode'])(
    'accepts supported glyph or brand token %j',
    (value) => expect(isSupportedAgentIconToken(value)).toBe(true),
  );

  test.each([
    'brand:unknown',
    'x'.repeat(AGENT_ICON_TOKEN_MAX_LENGTH + 1),
    'https://example.test/icon.png',
    'data:image/png;base64,AAAA',
    '/icons/private.png',
    'icons/private.png',
    'C:\\icons\\private.png',
  ])('rejects unsafe or unsupported token %j', (value) => {
    expect(isSupportedAgentIconToken(value)).toBe(false);
  });

  test('recognizes the exact longest supported brand token', () => {
    expect('brand:opencode').toHaveLength(14);
    expect(agentIconBrandKey('brand:opencode')).toBe('opencode');
  });
});
