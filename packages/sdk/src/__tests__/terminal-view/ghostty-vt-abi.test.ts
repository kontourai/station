import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TerminalViewProps } from '../../terminal-view';
import type { ControllerOptions } from '../../terminal-view/controller';
import * as abi from '../../terminal-view/engine/abi';
import { GHOSTTY_VT_SHA256 } from '../../terminal-view/engine/engine-client';
import { GHOSTTY_KEY_BY_CODE } from '../../terminal-view/engine/keys.generated';
import { GhosttyVtModule } from '../../terminal-view/engine/wasm';

const WASM_PATH = fileURLToPath(
  new URL(
    '../../terminal-view/vendor/ghostty-vt/ghostty-vt.wasm',
    import.meta.url,
  ),
);
const REVISION_PATH = fileURLToPath(
  new URL('../../terminal-view/vendor/ghostty-vt/REVISION', import.meta.url),
);
const LICENSE_PATH = fileURLToPath(
  new URL('../../terminal-view/vendor/ghostty-vt/LICENSE', import.meta.url),
);
const TYPES_PATH = fileURLToPath(
  new URL('../../terminal-view/vendor/ghostty-vt/types.json', import.meta.url),
);
const scriptPath = fileURLToPath(
  new URL('../../../../../scripts/ghostty-vt/build-wasm.mjs', import.meta.url),
);

interface Field {
  offset: number;
  size: number;
  type: string;
}
interface Manifest {
  schema: number;
  abi: { pointer_size: number; usize_size: number; endian: string };
  library_version: string;
  types: Record<
    string,
    | {
        kind: 'struct' | 'union';
        size: number;
        align: number;
        fields: Record<string, Field>;
      }
    | { kind: 'enum'; prefix: string; values: Record<string, number> }
    | { kind: string; size: number }
  >;
}

let manifest: Manifest;
let wasm: Uint8Array<ArrayBuffer>;

beforeAll(async () => {
  wasm = new Uint8Array(readFileSync(WASM_PATH));
  const vt = await GhosttyVtModule.instantiate(await WebAssembly.compile(wasm));
  manifest = vt.typeManifest() as Manifest;
});

describe('vendored libghostty-vt', () => {
  it('is the pinned Ghostty revision, built by the pinned toolchain', () => {
    const revision = readFileSync(REVISION_PATH, 'utf8');
    const script = readFileSync(scriptPath, 'utf8');
    const pinned = script.match(/GHOSTTY_REVISION = '([0-9a-f]{40})'/)?.[1];
    expect(pinned).toBe('83fb95624b0439ee660c2679b43b38c8b63769cd');
    expect(revision).toContain(`ghostty v1.4.0 ${pinned}`);
    expect(revision).toContain('zig 0.17.0');
    // libghostty-vt versions itself apart from Ghostty releases.
    expect(manifest.library_version).toBe('0.1.0-dev');
  });

  it('matches the recorded SHA-256', () => {
    const recorded = readFileSync(REVISION_PATH, 'utf8').match(
      /^sha256 ([0-9a-f]{64})$/m,
    )?.[1];
    expect(createHash('sha256').update(wasm).digest('hex')).toBe(recorded);
  });

  it('is the module the loader accepts', () => {
    const recorded = readFileSync(REVISION_PATH, 'utf8').match(
      /^sha256 ([0-9a-f]{64})$/m,
    )?.[1];
    expect(GHOSTTY_VT_SHA256).toBe(recorded);
  });

  it('ships Ghostty’s MIT license beside the binary', () => {
    expect(readFileSync(LICENSE_PATH, 'utf8')).toMatch(/MIT License/);
  });

  it('imports nothing from the host', () => {
    expect(WebAssembly.Module.imports(new WebAssembly.Module(wasm))).toEqual(
      [],
    );
  });

  it('matches the committed type manifest', () => {
    expect(JSON.parse(readFileSync(TYPES_PATH, 'utf8'))).toEqual(manifest);
  });

  it('is the wasm32 little-endian ABI the engine assumes', () => {
    expect(manifest.schema).toBe(1);
    expect(manifest.abi).toMatchObject({
      pointer_size: 4,
      usize_size: 4,
      endian: 'little',
    });
  });
});

describe('Station struct layouts match ghostty_type_json()', () => {
  for (const [name, layout] of Object.entries(abi.LAYOUT)) {
    it(name, () => {
      const type = manifest.types[name];
      expect(type, `${name} missing from the manifest`).toBeDefined();
      if (!type || !('fields' in type))
        throw new Error(`${name} is not a struct`);
      expect(type.size).toBe(layout.size);
      for (const [field, offset] of Object.entries(layout.fields)) {
        expect(type.fields[field], `${name}.${field}`).toBeDefined();
        expect(type.fields[field]!.offset, `${name}.${field}`).toBe(offset);
      }
    });
  }
});

const ENUMS: [string, Record<string, number>][] = [
  ['GhosttyResult', abi.Result],
  ['GhosttyTerminalOption', abi.TerminalOpt],
  ['GhosttyTerminalData', abi.TerminalData],
  ['GhosttyTerminalScrollViewportTag', abi.ScrollViewport],
  ['GhosttyRenderStateData', abi.RenderData],
  ['GhosttyRenderStateDirty', abi.RenderDirty],
  ['GhosttyRenderStateRowData', abi.RowData],
  ['GhosttyRenderStateRowCellsData', abi.CellsData],
  ['GhosttyCellData', abi.CellData],
  ['GhosttyCellWide', abi.CellWide],
  ['GhosttyRenderStateCursorVisualStyle', abi.CursorStyle],
  ['GhosttyKeyAction', abi.KeyAction],
  ['GhosttyMouseAction', abi.MouseAction],
  ['GhosttyMouseEncoderOption', abi.MouseEncoderOpt],
  ['GhosttyFocusEvent', abi.FocusEvent],
  ['GhosttyFormatterFormat', abi.FormatterFormat],
  ['GhosttySearchOption', abi.SearchOpt],
  ['GhosttySearchData', abi.SearchData],
  ['GhosttyPointTag', abi.PointTag],
  ['GhosttySelectionGestureEventType', abi.GestureEventType],
  ['GhosttySelectionGestureEventOption', abi.GestureEventOpt],
];

describe('Station enum values match ghostty_type_json()', () => {
  for (const [name, values] of ENUMS) {
    it(name, () => {
      const type = manifest.types[name];
      if (type?.kind !== 'enum' || !('values' in type))
        throw new Error(`${name} is not an enum in the manifest`);
      for (const [key, value] of Object.entries(values))
        expect(type.values[key], `${name}.${key}`).toBe(value);
    });
  }

  it('GhosttyKey matches the generated W3C code table', () => {
    const type = manifest.types.GhosttyKey;
    if (type?.kind !== 'enum' || !('values' in type))
      throw new Error('GhosttyKey missing');
    const byValue = new Map(
      Object.entries(type.values).map(([k, v]) => [v, k]),
    );
    for (const [code, value] of Object.entries(GHOSTTY_KEY_BY_CODE)) {
      const name = byValue.get(value);
      expect(name, code).toBeDefined();
      const pascal = name!
        .split('_')
        .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
        .join('');
      expect(code, name).toBe(/^[A-Z]$/.test(name!) ? `Key${name}` : pascal);
    }
  });
});

/** No public or controller option names a WebAssembly source. */
type WasmSourceOption = Extract<
  keyof TerminalViewProps | keyof ControllerOptions,
  `${string}${'wasm' | 'Wasm' | 'module' | 'Module'}${string}`
>;
const noWasmSourceOption: [WasmSourceOption] extends [never] ? true : false =
  true;

describe('loadGhosttyVt', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function freshLoader(body: Uint8Array<ArrayBuffer>) {
    const fetch = vi.fn(async (_url: URL) => new Response(body));
    vi.stubGlobal('fetch', fetch);
    vi.resetModules();
    const { loadGhosttyVt } = await import(
      '../../terminal-view/engine/engine-client'
    );
    return { loadGhosttyVt, fetch };
  }

  it('takes no source and fetches only the vendored file', async () => {
    expect(noWasmSourceOption).toBe(true);
    const { loadGhosttyVt, fetch } = await freshLoader(wasm);
    expect(loadGhosttyVt.length).toBe(0);
    await expect(loadGhosttyVt()).resolves.toBeInstanceOf(WebAssembly.Module);
    expect(String(fetch.mock.calls[0]?.[0])).toMatch(
      /\/vendor\/ghostty-vt\/ghostty-vt\.wasm$/,
    );
  });

  it('refuses a module whose SHA-256 differs from the recorded digest', async () => {
    const tampered = new Uint8Array(wasm);
    tampered[tampered.length - 1] ^= 0xff;
    const { loadGhosttyVt } = await freshLoader(tampered);
    await expect(loadGhosttyVt()).rejects.toThrow(
      /does not match its recorded SHA-256/,
    );
  });
});
