/**
 * station#1484 slice 1 — the one way the channel-state fixture corpus is
 * read. Fixtures are JSON on disk and are parsed with `JSON.parse`, not
 * declared as typed literals: a typed literal is a shape the compiler has
 * already vouched for, which is exactly the vouching an untrusted record
 * does not come with.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHANNEL_FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'channel-state',
);

export function readChannelFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(CHANNEL_FIXTURE_DIR, name), 'utf8'),
  ) as unknown;
}
