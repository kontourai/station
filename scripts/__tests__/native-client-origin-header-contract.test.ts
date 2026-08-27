import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLIENT_ORIGIN_HEADER } from '../../packages/contracts/src/client-origin.js';

const root = resolve(import.meta.dirname, '../..');

describe('native client-origin header contract', () => {
  it('keeps the native broker allowlist bound to the shared client-origin header', () => {
    const desktop = readFileSync(
      resolve(root, 'src-desktop/src/lib.rs'),
      'utf8',
    );

    // Rust cannot import the TypeScript contract, so this literal is the
    // explicit drift seam. Do not duplicate the header in native transport
    // code without this test: a browser-only CORS acceptance is insufficient
    // when desktop requests are brokered before network I/O.
    expect(desktop).toContain(`"${CLIENT_ORIGIN_HEADER.toLowerCase()}"`);
    expect(desktop).toContain('native_header_allowlisted');
  });
});
