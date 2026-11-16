// @vitest-environment node
import { describe, expect, it } from 'vitest';

// The upstream package registers source-map-support on import. That replaces
// the host's Error.prepareStackTrace, and the first stack read then parses and
// caches the whole server bundle's source map for the life of the process
// (about 690 MB of heap at rest). The pnpm patch removes the registration.
describe('patched @homebridge/ciao import', () => {
  it('leaves the host stack-trace formatter in place', async () => {
    const before = Error.prepareStackTrace;
    const ciao = await import('@homebridge/ciao');
    expect(typeof ciao.getResponder).toBe('function');
    expect(Error.prepareStackTrace).toBe(before);
  });
});
