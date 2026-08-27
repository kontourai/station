import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  corruptFile,
  reservedKeyShapes,
  truncatePrimaryKeepPrevious,
} from '../../infra/__tests__/helpers/store-faults.js';
import { GrantsStoreReservedKeyError } from '../grants-file-store.js';
import {
  allowMcpUiRender,
  isMcpUiRenderAllowed,
  isMcpUiRenderRevoked,
  McpUiRenderGrantsUnavailableError,
  revokeMcpUiRender,
  setMcpUiRenderAllowed,
} from '../mcp-ui-permissions.js';

describe('mcp-ui render permissions (allow + revoke)', () => {
  let home: string;
  let file: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mcp-ui-perms-'));
    file = join(home, 'mcp-ui-render-grants.json');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('a server is allowed by default (no store entry)', () => {
    expect(isMcpUiRenderRevoked(home, 'server-a')).toBe(false);
    expect(isMcpUiRenderAllowed(home, 'server-a')).toBe(true);
  });

  test('revoke denies rendering for that server only', async () => {
    await revokeMcpUiRender(home, 'server-a');
    expect(isMcpUiRenderRevoked(home, 'server-a')).toBe(true);
    expect(isMcpUiRenderAllowed(home, 'server-a')).toBe(false);
    // A different, untouched server stays allowed.
    expect(isMcpUiRenderRevoked(home, 'server-b')).toBe(false);
  });

  test('allow clears a prior revoke back to the open default', async () => {
    await revokeMcpUiRender(home, 'server-a');
    expect(isMcpUiRenderRevoked(home, 'server-a')).toBe(true);
    await allowMcpUiRender(home, 'server-a');
    expect(isMcpUiRenderRevoked(home, 'server-a')).toBe(false);
  });

  test('setMcpUiRenderAllowed round-trips and persists across reads', async () => {
    await setMcpUiRenderAllowed(home, 'server-a', false);
    await setMcpUiRenderAllowed(home, 'server-b', true);
    expect(isMcpUiRenderRevoked(home, 'server-a')).toBe(true);
    expect(isMcpUiRenderRevoked(home, 'server-b')).toBe(false);
  });

  test('a MISSING store file still answers the open default — absence is not an error', async () => {
    await revokeMcpUiRender(home, 'server-a');
    rmSync(file, { force: true });
    // Genuine absence means "no server was ever revoked". (The old test named
    // "a corrupt store file degrades to allowed" actually exercised THIS
    // case — it rmSync'd the file — while pinning fail-open as the policy for
    // real corruption; that policy is now inverted below.)
    expect(isMcpUiRenderRevoked(home, 'server-a')).toBe(false);
  });

  test('revoked server + corrupt store: the answer is NOT allowed (fail-closed, #1835)', async () => {
    await revokeMcpUiRender(home, 'server-a');
    corruptFile(file);

    // Pre-fix this read degraded to {} and silently re-allowed the revoked
    // server. An unreadable store must never answer "allowed".
    expect(() => isMcpUiRenderRevoked(home, 'server-a')).toThrow(
      McpUiRenderGrantsUnavailableError,
    );
    expect(() => isMcpUiRenderAllowed(home, 'server-a')).toThrow(
      McpUiRenderGrantsUnavailableError,
    );
  });

  test('corrupt store: writes throw and leave the on-disk bytes unchanged', async () => {
    await revokeMcpUiRender(home, 'server-a');
    corruptFile(file, '{ torn');

    await expect(setMcpUiRenderAllowed(home, 'server-b', true)).rejects.toThrow(
      McpUiRenderGrantsUnavailableError,
    );
    expect(readFileSync(file, 'utf-8')).toBe('{ torn');
  });

  test.each([
    ...reservedKeyShapes()
      .filter(({ label }) => ['null literal', 'array'].includes(label))
      .map(({ label, content }) => [label, content]),
    ['string-valued entry', '{"server-a":"revoked"}'],
    ['non-boolean renderAllowed', '{"server-a":{"renderAllowed":"false"}}'],
  ])('ill-shaped store (%s) throws instead of coercing', (_label, content) => {
    writeFileSync(file, content);
    expect(() => isMcpUiRenderRevoked(home, 'server-a')).toThrow(
      McpUiRenderGrantsUnavailableError,
    );
  });

  test('torn write: reads keep failing closed; `.previous` is forensic material for EXPLICIT recovery only', async () => {
    await setMcpUiRenderAllowed(home, 'server-a', false);
    await setMcpUiRenderAllowed(home, 'server-b', true); // second write retains `.previous`
    truncatePrimaryKeepPrevious(file);

    // Repeated reads throw — `.previous` is never auto-consumed.
    expect(() => isMcpUiRenderRevoked(home, 'server-a')).toThrow(
      McpUiRenderGrantsUnavailableError,
    );
    expect(() => isMcpUiRenderRevoked(home, 'server-a')).toThrow(
      McpUiRenderGrantsUnavailableError,
    );
    // `.previous` (the state before write #2) holds the revoke for the
    // operator's explicit recovery.
    expect(JSON.parse(readFileSync(`${file}.previous`, 'utf-8'))).toEqual({
      'server-a': { renderAllowed: false },
    });
    writeFileSync(file, readFileSync(`${file}.previous`));
    expect(isMcpUiRenderRevoked(home, 'server-a')).toBe(true);
  });

  test('a corrupt primary never resurrects a revoke-then-corrupt history as allowed (#1835 review finding 1)', async () => {
    // History: explicit allow, THEN revoke — `.previous` holds the ALLOWED
    // version. Auto-consuming it after corruption would silently re-allow.
    await allowMcpUiRender(home, 'server-a');
    await revokeMcpUiRender(home, 'server-a');
    expect(JSON.parse(readFileSync(`${file}.previous`, 'utf-8'))).toEqual({
      'server-a': { renderAllowed: true },
    });
    corruptFile(file);

    // The answer must never become "allowed" — every read throws, repeatedly,
    // and nothing is quarantined or rewritten.
    expect(() => isMcpUiRenderAllowed(home, 'server-a')).toThrow(
      McpUiRenderGrantsUnavailableError,
    );
    expect(() => isMcpUiRenderAllowed(home, 'server-a')).toThrow(
      McpUiRenderGrantsUnavailableError,
    );
    expect(readFileSync(file, 'utf-8')).toBe('not json');
    expect(
      readdirSync(home).filter((name) => name.includes('quarantine')),
    ).toEqual([]);
  });

  test('primary missing while `.previous` exists is a torn state, not the open default (#1835 review finding 1)', async () => {
    await revokeMcpUiRender(home, 'server-a');
    await setMcpUiRenderAllowed(home, 'server-b', true); // retains `.previous`
    rmSync(file);

    // Serving the open default here would re-allow server-a.
    expect(() => isMcpUiRenderRevoked(home, 'server-a')).toThrow(
      McpUiRenderGrantsUnavailableError,
    );
  });

  test('a server literally named __proto__ is rejected as a mutation target, never silently "revoked" (#1835 review finding 3)', async () => {
    // Pre-fix, grants['__proto__'] = {...} hit the prototype setter:
    // JSON.stringify wrote {} while the caller was told the revoke succeeded.
    await expect(revokeMcpUiRender(home, '__proto__')).rejects.toThrow(
      GrantsStoreReservedKeyError,
    );
    // Success is never paired with non-persisted state: nothing was written.
    expect(existsSync(file)).toBe(false);
  });
});
