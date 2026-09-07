import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { install, pnpmCommand } from '../dependency-lifecycle.mjs';
import {
  DEPENDENCY_INSTALL_GUARD,
  DEPENDENCY_INSTALL_RECORD_PREFIX,
  withDependencyInstallGuard,
} from '../lib/dependency-install-retirement.mjs';

const fixtures: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-dependency-retirement-'));
  fixtures.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}');
  const modules = join(root, 'node_modules');
  const guard = join(root, DEPENDENCY_INSTALL_GUARD);
  return { root, modules, guard, previous: join(guard, 'node_modules') };
}
function seed(path: string, name = '.DS_Store') {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, name), 'original');
}
afterEach(() => {
  for (const path of fixtures.splice(0))
    rmSync(path, { recursive: true, force: true });
});

test('a reused clean install clears its exact retired tree before npm without a second full-tree space requirement', () => {
  const f = fixture();
  seed(f.modules);
  const before = statSync(f.modules);
  const result = { verified: true };
  expect(
    withDependencyInstallGuard({
      root: f.root,
      clean: true,
      removeTree: (path, options) => {
        expect(existsSync(f.modules)).toBe(false);
        expect(statSync(f.previous).ino).toBe(before.ino);
        expect(readFileSync(join(f.previous, '.DS_Store'), 'utf8')).toBe(
          'original',
        );
        rmSync(path, options);
      },
      run: () => {
        expect(existsSync(f.modules)).toBe(false);
        expect(existsSync(f.previous)).toBe(false);
        seed(f.modules, 'verified');
        return result;
      },
    }),
  ).toBe(result);
  expect(existsSync(f.guard)).toBe(false);
  expect(readFileSync(join(f.modules, 'verified'), 'utf8')).toBe('original');
});

test.each(['npm', 'approved hook', 'verification'])(
  'a failed %s retains the partial new tree and prevents the next attempt erasing evidence',
  (phase) => {
    const f = fixture();
    seed(f.modules);
    expect(() =>
      withDependencyInstallGuard({
        root: f.root,
        clean: true,
        run: () => {
          seed(f.modules, 'partial');
          throw new Error(`${phase} failed`);
        },
      }),
    ).toThrow(/not verified/i);
    expect(existsSync(f.previous)).toBe(false);
    expect(readFileSync(join(f.modules, 'partial'), 'utf8')).toBe('original');
    expect(
      JSON.parse(readFileSync(join(f.guard, 'receipt.json'), 'utf8')).phase,
    ).toBe('failed');
    const next = vi.fn();
    expect(() =>
      withDependencyInstallGuard({ root: f.root, clean: true, run: next }),
    ).toThrow(/already exists/i);
    expect(next).not.toHaveBeenCalled();
  },
);

test('fresh and incremental installs keep their existing meanings', () => {
  const f = fixture();
  withDependencyInstallGuard({
    root: f.root,
    clean: true,
    run: () => seed(f.modules),
  });
  withDependencyInstallGuard({
    root: f.root,
    clean: false,
    run: () => {
      expect(readFileSync(join(f.modules, '.DS_Store'), 'utf8')).toBe(
        'original',
      );
      expect(existsSync(f.previous)).toBe(false);
      seed(f.modules, 'added');
    },
  });
  expect(existsSync(f.guard)).toBe(false);
  expect(existsSync(join(f.modules, 'added'))).toBe(true);
});

test('an existing guard, including a symlink, is never reclaimed or inspected for a dead PID', () => {
  const f = fixture();
  const outside = fixture();
  seed(outside.root, 'sentinel');
  symlinkSync(outside.root, f.guard, 'junction');
  const run = vi.fn();
  expect(() =>
    withDependencyInstallGuard({ root: f.root, clean: true, run }),
  ).toThrow(/already exists/i);
  expect(run).not.toHaveBeenCalled();
  expect(readFileSync(join(outside.root, 'sentinel'), 'utf8')).toBe('original');
});

test('a redirected node_modules is refused without touching the external tree', () => {
  const f = fixture();
  const outside = fixture();
  seed(outside.modules);
  symlinkSync(outside.modules, f.modules, 'junction');
  const run = vi.fn();
  expect(() =>
    withDependencyInstallGuard({ root: f.root, clean: true, run }),
  ).toThrow(/not verified/i);
  expect(run).not.toHaveBeenCalled();
  expect(readFileSync(join(outside.modules, '.DS_Store'), 'utf8')).toBe(
    'original',
  );
});

test('a reused guard name cannot make successful work delete a replacement owner', () => {
  const f = fixture();
  seed(f.modules);
  const moved = join(f.root, 'original-guard');
  expect(() =>
    withDependencyInstallGuard({
      root: f.root,
      clean: true,
      run: () => {
        seed(f.modules, 'verified');
        renameSync(f.guard, moved);
        seed(f.guard, 'new-owner');
      },
    }),
  ).toThrow(/not verified/i);
  expect(readFileSync(join(f.guard, 'new-owner'), 'utf8')).toBe('original');
  expect(
    JSON.parse(readFileSync(join(moved, 'receipt.json'), 'utf8')).phase,
  ).toBe('failed');
});

test('a replaced retired tree cannot redirect cleanup', () => {
  const f = fixture();
  const outside = fixture();
  seed(f.modules);
  seed(outside.modules, 'sentinel');
  const run = vi.fn();
  expect(() =>
    withDependencyInstallGuard({
      root: f.root,
      clean: true,
      removeTree: () => {
        renameSync(f.previous, join(f.root, 'original-modules'));
        symlinkSync(outside.modules, f.previous, 'junction');
      },
      run,
    }),
  ).toThrow(/not verified/i);
  expect(readFileSync(join(outside.modules, 'sentinel'), 'utf8')).toBe(
    'original',
  );
  expect(run).not.toHaveBeenCalled();
  expect(
    readFileSync(join(f.root, 'original-modules', '.DS_Store'), 'utf8'),
  ).toBe('original');
});

test('an asynchronous callback cannot release an unfinished install', () => {
  const f = fixture();
  expect(() =>
    withDependencyInstallGuard({
      root: f.root,
      clean: true,
      run: () => Promise.resolve(),
    }),
  ).toThrow(/not verified/i);
  expect(existsSync(f.guard)).toBe(true);
});

test('a retired-tree cleanup failure stops before npm and retains remaining generated data', () => {
  const f = fixture();
  seed(f.modules);
  const warn = vi.fn();
  const run = vi.fn(() => {
    seed(f.modules, 'verified');
    return 'verified';
  });
  const removeTree = vi.fn(() => {
    throw new Error('ENOTEMPTY');
  });
  expect(() =>
    withDependencyInstallGuard({
      root: f.root,
      clean: true,
      run,
      warn,
      removeTree,
    }),
  ).toThrow(/not verified/i);
  expect(run).not.toHaveBeenCalled();
  expect(removeTree).toHaveBeenCalledTimes(1);
  expect(warn).not.toHaveBeenCalled();
  expect(
    JSON.parse(readFileSync(join(f.guard, 'receipt.json'), 'utf8')).phase,
  ).toBe('failed');
  expect(existsSync(join(f.previous, '.DS_Store'))).toBe(true);
  expect(existsSync(f.modules)).toBe(false);
});

test('unexpected guard children remain visible after successful verification', () => {
  const f = fixture();
  seed(f.modules);
  const warn = vi.fn();
  expect(
    withDependencyInstallGuard({
      root: f.root,
      warn,
      run: () => {
        seed(f.modules, 'verified');
        writeFileSync(join(f.guard, 'unexpected'), 'keep');
        return 'verified';
      },
    }),
  ).toBe('verified');
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining('cleanup is pending'),
  );
  expect(readFileSync(join(f.guard, 'unexpected'), 'utf8')).toBe('keep');
  expect(
    JSON.parse(readFileSync(join(f.guard, 'receipt.json'), 'utf8')).phase,
  ).toBe('verified');
});

test('successful guard state and ordinary macOS metadata are preserved while the fixed name is released', () => {
  const f = fixture();
  const warn = vi.fn();
  withDependencyInstallGuard({
    root: f.root,
    warn,
    run: () => {
      seed(f.modules, 'verified');
      writeFileSync(join(f.guard, '.DS_Store'), 'metadata');
    },
  });
  expect(warn).not.toHaveBeenCalled();
  expect(existsSync(f.guard)).toBe(false);
  const records = readdirSync(f.root).filter((name) =>
    name.startsWith(DEPENDENCY_INSTALL_RECORD_PREFIX),
  );
  expect(records).toHaveLength(1);
  const state = join(f.root, records[0]);
  expect(readFileSync(join(state, 'macos-directory-metadata'), 'utf8')).toBe(
    'metadata',
  );
  expect(
    JSON.parse(readFileSync(join(state, 'receipt.json'), 'utf8')).phase,
  ).toBe('verified');
  withDependencyInstallGuard({ root: f.root, clean: false, run: () => {} });
  expect(existsSync(f.guard)).toBe(false);
});

test('metadata created after validation keeps the fixed guard pending', () => {
  const f = fixture();
  const warn = vi.fn();
  withDependencyInstallGuard({
    root: f.root,
    warn,
    run: () => seed(f.modules),
    moveEntry: (from, to) => {
      renameSync(from, to);
      if (String(from).endsWith('receipt.json'))
        writeFileSync(join(f.guard, '.DS_Store'), 'x'.repeat(65_537));
    },
  });
  expect(existsSync(f.guard)).toBe(true);
  expect(statSync(join(f.guard, '.DS_Store')).size).toBe(65_537);
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining('cleanup is pending'),
  );
});

test('metadata grown between validation and publication is preserved without releasing the fixed guard', () => {
  const f = fixture();
  const warn = vi.fn();
  withDependencyInstallGuard({
    root: f.root,
    warn,
    run: () => {
      seed(f.modules);
      writeFileSync(join(f.guard, '.DS_Store'), 'small');
    },
    moveEntry: (from, to) => {
      if (String(from).endsWith('.DS_Store')) {
        rmSync(from);
        writeFileSync(from, 'x'.repeat(65_537));
      }
      renameSync(from, to);
    },
  });
  expect(existsSync(f.guard)).toBe(true);
  const record = readdirSync(f.root).find((name) =>
    name.startsWith(DEPENDENCY_INSTALL_RECORD_PREFIX),
  )!;
  expect(statSync(join(f.root, record, 'macos-directory-metadata')).size).toBe(
    65_537,
  );
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining('cleanup is pending'),
  );
});

test('a receipt replacement during publication is preserved without releasing the fixed guard', () => {
  const f = fixture();
  const warn = vi.fn();
  const original = join(f.root, 'owned-receipt');
  withDependencyInstallGuard({
    root: f.root,
    warn,
    run: () => seed(f.modules),
    moveEntry: (from, to) => {
      if (String(from).endsWith('receipt.json')) {
        renameSync(from, original);
        writeFileSync(from, 'replacement');
      }
      renameSync(from, to);
    },
  });
  expect(existsSync(f.guard)).toBe(true);
  expect(JSON.parse(readFileSync(original, 'utf8')).phase).toBe('verified');
  const record = readdirSync(f.root).find((name) =>
    name.startsWith(DEPENDENCY_INSTALL_RECORD_PREFIX),
  )!;
  expect(readFileSync(join(f.root, record, 'receipt.json'), 'utf8')).toBe(
    'replacement',
  );
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining('cleanup is pending'),
  );
});

test.each(['large', 'directory', 'link'])(
  'unexpected %s macOS metadata cannot silently release the guard',
  (kind) => {
    const f = fixture();
    const outside = fixture();
    const warn = vi.fn();
    withDependencyInstallGuard({
      root: f.root,
      warn,
      run: () => {
        const path = join(f.guard, '.DS_Store');
        if (kind === 'large') writeFileSync(path, 'x'.repeat(65_537));
        else if (kind === 'directory') mkdirSync(path);
        else symlinkSync(outside.root, path, 'junction');
      },
    });
    expect(existsSync(f.guard)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('cleanup is pending'),
    );
  },
);

test('a root target recreated after retired cleanup is preserved and never handed to npm', () => {
  const f = fixture();
  seed(f.modules);
  const run = vi.fn();
  expect(() =>
    withDependencyInstallGuard({
      root: f.root,
      removeTree: (path, options) => {
        rmSync(path, options);
        seed(f.modules, 'replacement-owner');
      },
      run,
    }),
  ).toThrow(/not verified/i);
  expect(run).not.toHaveBeenCalled();
  expect(readFileSync(join(f.modules, 'replacement-owner'), 'utf8')).toBe(
    'original',
  );
  expect(existsSync(f.previous)).toBe(false);
});

test('a replacement receipt is not overwritten by the failed-operation record', () => {
  const f = fixture();
  const receipt = join(f.guard, 'receipt.json');
  const original = join(f.root, 'original-receipt');
  expect(() =>
    withDependencyInstallGuard({
      root: f.root,
      run: () => {
        renameSync(receipt, original);
        writeFileSync(receipt, 'replacement owner');
      },
    }),
  ).toThrow(/not verified/i);
  expect(readFileSync(receipt, 'utf8')).toBe('replacement owner');
  expect(JSON.parse(readFileSync(original, 'utf8')).phase).toBe('failed');
});

test('a file named node_modules is refused before the operation runs', () => {
  const f = fixture();
  writeFileSync(f.modules, 'not a generated directory');
  const run = vi.fn();
  expect(() => withDependencyInstallGuard({ root: f.root, run })).toThrow(
    /not verified/i,
  );
  expect(run).not.toHaveBeenCalled();
  expect(readFileSync(f.modules, 'utf8')).toBe('not a generated directory');
});

test('a second participating installer cannot enter the active guard', () => {
  const f = fixture();
  const second = vi.fn();
  withDependencyInstallGuard({
    root: f.root,
    run: () => {
      expect(() =>
        withDependencyInstallGuard({ root: f.root, run: second }),
      ).toThrow(/already exists/i);
      seed(f.modules, 'verified');
    },
  });
  expect(second).not.toHaveBeenCalled();
  expect(existsSync(f.guard)).toBe(false);
});

test('another real process cannot enter the active installer guard', () => {
  const f = fixture();
  const moduleUrl = new URL(
    '../lib/dependency-install-retirement.mjs',
    import.meta.url,
  ).href;
  withDependencyInstallGuard({
    root: f.root,
    run: () => {
      const script = `import { withDependencyInstallGuard } from ${JSON.stringify(moduleUrl)}; withDependencyInstallGuard({ root: ${JSON.stringify(f.root)}, run() { throw new Error('second installer entered'); } });`;
      const child = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
          cwd: f.root,
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 128 * 1024,
          windowsHide: true,
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      expect(child.stderr).toContain('installer guard already exists');
      expect(child.stderr).not.toContain('Error: second installer entered');
    },
  });
});

function pipeline(f: ReturnType<typeof fixture>, failed?: string) {
  const pnpmCliPath = join(f.root, 'tools', 'pnpm.cjs');
  seed(join(f.root, 'tools'), 'pnpm.cjs');
  const calls: string[] = [];
  const reuse =
    existsSync(join(f.modules, '.modules.yaml')) &&
    !existsSync(join(f.modules, '.package-lock.json'));
  const phase = (name: string) => {
    calls.push(name);
    if (
      ['pnpm', 'stage', 'hooks', 'owned', 'verify'].includes(name) ||
      (name === 'policy' &&
        calls.filter((call) => call === 'policy').length > 1)
    )
      expect(existsSync(f.guard)).toBe(true);
    if (name === failed) throw new Error(`${name} fault`);
  };
  const execution = {
    root: f.root,
    nodePath: process.execPath,
    pnpmInvocation: () => ({ command: process.execPath, args: [pnpmCliPath] }),
    command: vi.fn(() => {
      phase('node');
    }),
    check: vi.fn(() => {
      phase('policy');
      return { entries: [] };
    }),
    pnpmCommand: vi.fn(() => {
      phase('pnpm');
      expect(existsSync(f.modules)).toBe(reuse);
      expect(existsSync(f.guard)).toBe(true);
      expect(existsSync(f.previous)).toBe(false);
      seed(f.modules, 'fresh');
      writeFileSync(join(f.modules, '.modules.yaml'), 'pnpm metadata');
    }),
    stageLifecyclePrebuilds: vi.fn(() => {
      phase('stage');
    }),
    runApprovedHooks: vi.fn(() => {
      phase('hooks');
    }),
    stationOwnedHooks: vi.fn(() => {
      phase('owned');
    }),
    verify: vi.fn(() => {
      phase('verify');
      return { allowlist: {}, purls: [] };
    }),
  };
  return { execution, pnpmCliPath, calls };
}

const installWithExecution = install as unknown as (
  options: { developer?: boolean },
  execution: ReturnType<typeof pipeline>['execution'],
) => unknown;

test('the production installer binds its selected driver and guards the actual phase order', () => {
  const f = fixture();
  seed(f.modules);
  const p = pipeline(f);
  installWithExecution({}, p.execution);
  expect(p.calls).toEqual([
    'node',
    'policy',
    'pnpm',
    'policy',
    'stage',
    'hooks',
    'owned',
    'verify',
  ]);
  expect(p.execution.pnpmCommand).toHaveBeenCalledWith(
    [
      'install',
      '--ignore-scripts',
      '--config.node-linker=hoisted',
      '--config.enable-global-virtual-store=false',
      '--package-import-method=clone-or-copy',
      '--frozen-lockfile',
    ],
    f.root,
    {
      command: realpathSync(process.execPath),
      args: [realpathSync(p.pnpmCliPath)],
    },
  );
  expect(p.execution.check).toHaveBeenNthCalledWith(1, {
    cwd: f.root,
    bootstrap: true,
  });
  expect(existsSync(f.guard)).toBe(false);
  expect(existsSync(join(f.modules, 'fresh'))).toBe(true);
});

test.each(['npm-only', 'hybrid', 'unidentified'])(
  'the production installer retires a %s tree once and reuses its subsequent pnpm tree',
  (kind) => {
    const f = fixture();
    seed(f.modules, 'old-extraneous-package');
    if (kind !== 'unidentified')
      writeFileSync(join(f.modules, '.package-lock.json'), '{}');
    if (kind === 'hybrid')
      writeFileSync(join(f.modules, '.modules.yaml'), 'old hybrid');
    const first = pipeline(f);
    installWithExecution({}, first.execution);
    expect(existsSync(join(f.modules, 'old-extraneous-package'))).toBe(false);
    expect(existsSync(join(f.modules, '.package-lock.json'))).toBe(false);
    const installed = statSync(f.modules);
    writeFileSync(join(f.modules, 'pnpm-preserved'), 'preserve this tree');
    const second = pipeline(f);
    installWithExecution({}, second.execution);
    expect(statSync(f.modules).ino).toBe(installed.ino);
    expect(readFileSync(join(f.modules, 'pnpm-preserved'), 'utf8')).toBe(
      'preserve this tree',
    );
    expect(existsSync(f.guard)).toBe(false);
  },
);

test('developer installs preserve established pnpm trees while allowing an intentional lock refresh', () => {
  const f = fixture();
  seed(f.modules, '.modules.yaml');
  const before = statSync(f.modules);
  const p = pipeline(f);
  installWithExecution({ developer: true }, p.execution);
  expect(p.execution.pnpmCommand).toHaveBeenCalledWith(
    expect.arrayContaining([
      'install',
      '--ignore-scripts',
      '--no-frozen-lockfile',
    ]),
    f.root,
    expect.any(Object),
  );
  expect(statSync(f.modules).ino).toBe(before.ino);
});

test.each(['hooks', 'owned', 'verify'])(
  'the actual installer retains the partial new tree after its %s phase fails',
  (failed) => {
    const f = fixture();
    seed(f.modules);
    const p = pipeline(f, failed);
    expect(() => installWithExecution({}, p.execution)).toThrow(
      /not verified/i,
    );
    expect(p.execution.pnpmCommand).toHaveBeenCalledTimes(1);
    expect(p.calls.at(-1)).toBe(failed);
    expect(existsSync(f.previous)).toBe(false);
    expect(readFileSync(join(f.modules, 'fresh'), 'utf8')).toBe('original');
    expect(
      JSON.parse(readFileSync(join(f.guard, 'receipt.json'), 'utf8')).phase,
    ).toBe('failed');
  },
);

test.each(['node', 'pnpm script', 'pnpm executable'])(
  'an install refuses a %s driver within node_modules before acquiring a guard or executing the manager',
  (kind) => {
    const f = fixture();
    seed(f.modules);
    const p = pipeline(f);
    const inside = join(f.modules, kind === 'node' ? 'node' : 'pnpm.cjs');
    writeFileSync(inside, 'driver');
    if (kind === 'node') p.execution.nodePath = inside;
    else
      p.execution.pnpmInvocation = () =>
        kind === 'pnpm executable'
          ? { command: inside, args: [] }
          : { command: process.execPath, args: [inside] };
    expect(() => installWithExecution({}, p.execution)).toThrow(
      /outside root node_modules/,
    );
    expect(p.execution.command).toHaveBeenCalledTimes(kind === 'node' ? 0 : 1);
    expect(p.execution.pnpmCommand).not.toHaveBeenCalled();
    expect(existsSync(f.guard)).toBe(false);
    expect(existsSync(join(f.modules, '.DS_Store'))).toBe(true);
  },
);

test('a pnpm link inside node_modules binds the external canonical driver before incremental installation', () => {
  const f = fixture();
  seed(f.modules);
  const p = pipeline(f);
  symlinkSync(join(f.root, 'tools'), join(f.modules, 'npm'), 'junction');
  p.execution.pnpmInvocation = () => ({
    command: process.execPath,
    args: [join(f.modules, 'npm', 'pnpm.cjs')],
  });
  installWithExecution({}, p.execution);
  expect(p.execution.pnpmCommand).toHaveBeenCalledWith(
    expect.arrayContaining([
      'install',
      '--ignore-scripts',
      '--frozen-lockfile',
    ]),
    f.root,
    {
      command: realpathSync(process.execPath),
      args: [realpathSync(p.pnpmCliPath)],
    },
  );
  expect(existsSync(p.pnpmCliPath)).toBe(true);
  expect(existsSync(f.guard)).toBe(false);
});

test('the real command runner executes its bound external driver after the legacy tree containing its alias is gone', () => {
  const f = fixture();
  seed(f.modules, '.package-lock.json');
  const p = pipeline(f);
  const aliasDirectory = join(f.modules, 'manager');
  symlinkSync(join(f.root, 'tools'), aliasDirectory, 'junction');
  p.execution.pnpmInvocation = () => ({
    command: process.execPath,
    args: [join(aliasDirectory, 'pnpm.cjs')],
  });
  writeFileSync(
    p.pnpmCliPath,
    `const fs = require('node:fs');
if (!fs.existsSync('.station-dependency-install')) throw new Error('guard missing during driver execution');
if (fs.existsSync('node_modules')) throw new Error('legacy tree was not retired');
fs.mkdirSync('node_modules');
fs.writeFileSync('node_modules/.modules.yaml', 'pnpm metadata');
fs.writeFileSync('driver-result.json', JSON.stringify({ driver: __filename, args: process.argv.slice(2) }));`,
  );
  const execution = { ...p.execution, pnpmCommand };
  installWithExecution({}, execution as unknown as typeof p.execution);
  const result = JSON.parse(
    readFileSync(join(f.root, 'driver-result.json'), 'utf8'),
  );
  expect(result.driver).toBe(realpathSync(p.pnpmCliPath));
  expect(result.args).toEqual([
    'install',
    '--ignore-scripts',
    '--config.node-linker=hoisted',
    '--config.enable-global-virtual-store=false',
    '--package-import-method=clone-or-copy',
    '--frozen-lockfile',
  ]);
  expect(existsSync(aliasDirectory)).toBe(false);
  expect(existsSync(f.guard)).toBe(false);
});

test('an external alias cannot hide a driver target inside the retirement tree', () => {
  const f = fixture();
  seed(f.modules, 'pnpm.cjs');
  const p = pipeline(f);
  symlinkSync(f.modules, join(f.root, 'tools', 'local'), 'junction');
  p.execution.pnpmInvocation = () => ({
    command: process.execPath,
    args: [join(f.root, 'tools', 'local', 'pnpm.cjs')],
  });
  expect(() => installWithExecution({}, p.execution)).toThrow(
    /outside root node_modules/,
  );
  expect(p.execution.command).toHaveBeenCalledTimes(1);
  expect(existsSync(f.guard)).toBe(false);
});

import { spawnSync } from 'node:child_process';
