import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  TROUBLESHOOT_PLAYBOOK,
  TROUBLESHOOT_PLAYBOOK_VERSION,
} from '../troubleshoot-playbook.js';

describe('troubleshoot playbook', () => {
  test('the compiled constant is byte-identical to the reviewable Markdown', () => {
    const markdown = readFileSync(
      fileURLToPath(new URL('../troubleshoot-playbook.md', import.meta.url)),
    );
    expect(Buffer.from(TROUBLESHOOT_PLAYBOOK, 'utf8').equals(markdown)).toBe(
      true,
    );
  });

  test('names its own version in the heading', () => {
    expect(TROUBLESHOOT_PLAYBOOK_VERSION).toBe(2);
    expect(TROUBLESHOOT_PLAYBOOK.split('\n', 1)[0]).toBe(
      `# Station troubleshooting playbook v${TROUBLESHOOT_PLAYBOOK_VERSION}`,
    );
  });
});
