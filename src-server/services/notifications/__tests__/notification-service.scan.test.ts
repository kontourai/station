import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

// The whole-tree scan split from notification-service.test.ts so it runs in
// the repo-scans lane (#2176): a new schedule() caller anywhere in
// src-server has no import edge to this suite.
vi.mock('../../../telemetry/metrics.js', () => ({
  notificationOps: { add: vi.fn() },
}));

const { INTERNAL_NOTIFICATION_SOURCES } = await import(
  '../notification-service.js'
);

describe('NotificationService cross-source dedupe (#2597)', () => {
  test('INTERNAL_NOTIFICATION_SOURCES covers every in-process schedule() caller', () => {
    const root = join(process.cwd(), 'src-server');
    // A caller may alias a published contracts constant
    // (`const SOURCE = TURN_COMPLETION_NOTIFICATION_SOURCE`), so resolve
    // exported string constants from the contracts package too.
    const contractsRoot = join(process.cwd(), 'packages/contracts/src');
    const contractConstants = new Map<string, string>();
    for (const entry of readdirSync(contractsRoot, { recursive: true })) {
      const file = String(entry);
      if (!file.endsWith('.ts') || file.includes('__tests__')) continue;
      const text = readFileSync(join(contractsRoot, file), 'utf8');
      for (const match of text.matchAll(
        /export const ([A-Z][A-Z0-9_]*) = '([^']+)'/g,
      ))
        contractConstants.set(match[1], match[2]);
    }
    const found = new Set<string>();
    for (const entry of readdirSync(root, { recursive: true })) {
      const file = String(entry);
      if (!file.endsWith('.ts') || file.includes('__tests__')) continue;
      const text = readFileSync(join(root, file), 'utf8');
      for (const match of text.matchAll(
        /notificationService!?\??\.(?:schedule|scheduleEnveloped)\(\s*([^,\s)]+)/g,
      )) {
        const arg = match[1];
        const literal = /^'([^']+)'$/.exec(arg)?.[1];
        const constant = new RegExp(`const ${arg} = '([^']+)'`).exec(text)?.[1];
        const alias = new RegExp(`const ${arg} = ([A-Z][A-Z0-9_]*);`).exec(
          text,
        )?.[1];
        const aliased = alias ? contractConstants.get(alias) : undefined;
        found.add(
          literal ?? constant ?? aliased ?? `<unresolved ${arg} in ${file}>`,
        );
      }
    }
    // The scan must reach the known callers, or it proves nothing.
    expect([...found]).toEqual(
      expect.arrayContaining([
        'scheduler',
        'approval-inbox',
        'turn-completion',
      ]),
    );
    for (const source of found)
      expect(INTERNAL_NOTIFICATION_SOURCES.has(source), source).toBe(true);
  });
});
