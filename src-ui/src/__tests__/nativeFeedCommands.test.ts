/**
 * #2608: the webview names native commands by string. A rename on either
 * side would make an invoke fail — and a failed "is the host the consumer?"
 * is how both the host and the webview would post. Every command these
 * modules invoke must be registered in the desktop `generate_handler!`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

function invokedCommands(source: string): string[] {
  return [
    ...source.matchAll(/invokeTauri(?:<[^>]*>)?\(\s*['"`]([a-z_]+)['"`]/g),
  ]
    .map((match) => match[1] ?? '')
    .concat(
      [...source.matchAll(/_COMMAND = ['"`]([a-z_]+)['"`]/g)].map(
        (match) => match[1] ?? '',
      ),
    );
}

function desktopHandlerCommands(lib: string): string[] {
  const start = lib.indexOf(
    '#[cfg(not(mobile))]\n    let builder = builder.invoke_handler(tauri::generate_handler![',
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const block = lib.slice(start, lib.indexOf(']);', start));
  return [...block.matchAll(/(?:[a-z_]+::)*([a-z_]+),?\s*$/gm)].map(
    (match) => match[1] ?? '',
  );
}

describe('native feed commands are registered (#2608)', () => {
  test('every command the feed and click modules invoke is in the desktop handler', () => {
    const commands = [
      ...invokedCommands(read('src-ui/src/platform/native/deliveryFeed.ts')),
      ...invokedCommands(read('src-ui/src/lib/notificationOpen.ts')),
    ];
    expect(new Set(commands)).toEqual(
      new Set([
        'notification_feed_native_consumer',
        'notification_feed_adopt_cursor',
        'take_notification_open_link',
      ]),
    );
    const registered = desktopHandlerCommands(read('src-desktop/src/lib.rs'));
    for (const command of commands) expect(registered).toContain(command);
  });
});
