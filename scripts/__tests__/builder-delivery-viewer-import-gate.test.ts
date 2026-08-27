import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  scanFile,
  scopedFiles,
} from '../builder-delivery-viewer-import-gate.mjs';

describe('builder-delivery-viewer import gate', () => {
  it('allows published Flow Agents and Surface contracts', () => {
    expect(
      scanFile(
        'plugin.mjs',
        "import { validateTrustBundle } from '@kontourai/flow-agents';\nimport '@kontourai/surface/trust-panel/element';",
      ),
    ).toEqual([]);
  });
  it('rejects Flow Agents internals and segmented filesystem escapes', () => {
    expect(
      scanFile(
        'evil.mjs',
        "import x from '@kontourai/flow-agents/build/src/index.js';",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      scanFile(
        'evil.mjs',
        "import * as Flow from '@kontourai/flow-agents'; Flow.writeState();",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      scanFile(
        'evil.mjs',
        "import Flow from '@kontourai/flow-agents'; Flow.writeState();",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      scanFile(
        'evil.mjs',
        "const Flow = require('@kontourai/' + 'flow-agents');",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      scanFile('evil.mjs', "join('node_modules/@kontourai/flow-agents/kits/x')")
        .length,
    ).toBeGreaterThan(0);
    expect(
      scanFile(
        'evil.mjs',
        "import x from '@kontourai/flow-agents/dist/private.js';",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      scanFile(
        'evil.mjs',
        "join('node_modules', '@kontourai', 'flow-' + 'agents', 'dist', 'x')",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      scanFile(
        'evil.mjs',
        "import { recordEvidence } from '@kontourai/flow-agents';",
      ).length,
    ).toBeGreaterThan(0);
  });
  it('rejects Station core and sibling checkout imports', () => {
    expect(
      scanFile('evil.mjs', "import x from '../../src-server/routes/x';").length,
    ).toBeGreaterThan(0);
    expect(
      scanFile('evil.mjs', "import x from '../../../station/src-ui/x';").length,
    ).toBeGreaterThan(0);
    expect(
      scanFile('evil.mjs', "join('..', '..', 'station', 'src-' + 'ui', 'x')")
        .length,
    ).toBeGreaterThan(0);
  });
  it('rejects mutation-oriented server capabilities', () => {
    expect(
      scanFile(
        'evil.mjs',
        "import { readFile, writeFile } from 'node:fs/promises';",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      scanFile('evil.mjs', "import { exec } from 'node:child_process';").length,
    ).toBeGreaterThan(0);
    for (const source of [
      "import * as fs from 'node:fs'; fs.writeFileSync('x', 'y');",
      "import fs from 'node:fs'; fs.rmSync('x');",
      "const fs = require('node:' + 'fs'); fs.writeFileSync('x', 'y');",
      "const fs = await import('node:fs/promises'); await fs.writeFile('x', 'y');",
      "const name = 'node:fs'; const fs = require(name);",
      "require.call(null, 'node:fs').writeFileSync('x', 'y');",
      "require['call'](null, 'node:fs').writeFileSync('x', 'y');",
      "module.require('node:fs').writeFileSync('x', 'y');",
      "const load = require; load('@kontourai/flow-agents').writeState();",
      "const load = createRequire(import.meta.url); load('node:fs').writeFileSync('x', 'y');",
      "export { writeFileSync } from 'node:fs';",
      "process.getBuiltinModule('fs').writeFileSync('x', 'y');",
      "globalThis['process']['getBuiltinModule']('fs').writeFileSync('x', 'y');",
      "fetch('/api/write', { method: 'POST' });",
      "const send = fetch; send('/api/write', { method: 'POST' });",
      "import './__tests__/mutation-helper.mjs';",
      "globalThis['fetch']('/write', { method: 'POST' });",
      "fetch(new Request('/write', { method: 'POST' }));",
      "const url = new Request('/write', { method: 'POST' }); fetch(url);",
      "import { constants } from 'node:fs'; import { open } from 'node:fs/promises'; await open('/tmp/pwn', constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC);",
      "import { constants } from 'node:fs'; import { open } from 'node:fs/promises'; await open('/tmp/pwn', 'w');",
      "navigator.sendBeacon('/api/write', 'x');",
      "window['fe' + 'tch']('/write', { method: 'POST' });",
      "const send = window['fe' + 'tch']; send('/write', { method: 'POST' });",
      "window['navi' + 'gator']['send' + 'Beacon']('/write', 'x');",
      "global['pro' + 'cess']['get' + 'BuiltinModule']('fs').writeFileSync('/tmp/x', 'x');",
      "const C = window['Re' + 'quest']; const payload = new C('/write', { method: 'POST' }); load(payload as string);",
      "async function load(url: string) { const Ctor = window[['Req', 'uest'].join('')]; { const url = new Ctor('/write', { method: 'POST' }); return fetch(url); } }",
      "const key = ['f', 'e', 't', 'c', 'h'].join(''); window[key]('/write', { method: 'POST' });",
    ])
      expect(scanFile('evil.mjs', source).length).toBeGreaterThan(0);
  });
  it('passes the tracked plugin source', () => {
    const findings = scopedFiles().flatMap((file) =>
      scanFile(file, readFileSync(file, 'utf8')),
    );
    expect(findings).toEqual([]);
  });
});
