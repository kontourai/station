/**
 * The lowest layer over the vendored libghostty-vt WebAssembly module:
 * instantiation, linear-memory access and callback registration. Station
 * writes this from Ghostty's public headers (`include/ghostty/vt/*.h`); it
 * knows nothing about terminals beyond the C ABI.
 *
 * Any exported call that allocates may grow linear memory, which detaches
 * every `ArrayBuffer` view made before it. Callers therefore never hold a
 * view across a call: `bytes()` and `data()` re-read `memory.buffer` and
 * rebuild their view whenever the buffer identity or length changed.
 */

export interface GhosttyVtExports {
  readonly memory: WebAssembly.Memory;
  readonly __indirect_function_table: WebAssembly.Table;
  /** Every export, for looking up C functions by name. */
  readonly all: WebAssembly.Exports;
}

export type WasmValueType = 'i32' | 'i64' | 'f32' | 'f64';

/** A C function signature as WebAssembly types (wasm32: pointers are i32). */
export interface WasmSignature {
  params: readonly WasmValueType[];
  results: readonly WasmValueType[];
}

const VALUE_TYPE_CODE: Record<WasmValueType, number> = {
  i32: 0x7f,
  i64: 0x7e,
  f32: 0x7d,
  f64: 0x7c,
};

function uleb(value: number): number[] {
  const out: number[] = [];
  let rest = value >>> 0;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    out.push(byte);
  } while (rest !== 0);
  return out;
}

function section(id: number, content: number[]): number[] {
  return [id, ...uleb(content.length), ...content];
}

/**
 * A one-function module that imports `t.f` with `signature` and exports it
 * again. The re-export is a genuine WebAssembly function, which is what a
 * funcref table accepts; a plain JavaScript function is not, without the
 * still-optional type-reflection proposal.
 */
export function trampolineModuleBytes(
  signature: WasmSignature,
): Uint8Array<ArrayBuffer> {
  const functype = [
    0x60,
    ...uleb(signature.params.length),
    ...signature.params.map((type) => VALUE_TYPE_CODE[type]),
    ...uleb(signature.results.length),
    ...signature.results.map((type) => VALUE_TYPE_CODE[type]),
  ];
  const name = (text: string) => [
    text.length,
    ...[...text].map((c) => c.charCodeAt(0)),
  ];
  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...section(1, [1, ...functype]),
    ...section(2, [1, ...name('t'), ...name('f'), 0x00, 0x00]),
    ...section(7, [1, ...name('f'), 0x00, 0x00]),
  ]);
}

const trampolineModules = new Map<string, WebAssembly.Module>();

export class GhosttyVtError extends Error {
  constructor(
    readonly operation: string,
    readonly result: number,
  ) {
    super(`libghostty-vt ${operation} failed (${result})`);
    this.name = 'GhosttyVtError';
  }
}

export const GHOSTTY_SUCCESS = 0;
export const GHOSTTY_OUT_OF_SPACE = -3;
export const GHOSTTY_NO_VALUE = -4;

export class GhosttyVtModule {
  private cachedBuffer: ArrayBuffer | null = null;
  private cachedBytes = new Uint8Array(0);
  private cachedView = new DataView(new ArrayBuffer(0));
  private readonly freeTableSlots: number[] = [];

  private constructor(readonly exports: GhosttyVtExports) {}

  static async instantiate(
    module: WebAssembly.Module,
  ): Promise<GhosttyVtModule> {
    // libghostty-vt is freestanding: it imports nothing. Refuse a module
    // that asks for host functions rather than inventing them.
    const imports = WebAssembly.Module.imports(module);
    if (imports.length > 0)
      throw new Error(
        `Unexpected libghostty-vt imports: ${imports.map((i) => `${i.module}.${i.name}`).join(', ')}`,
      );
    const instance = await WebAssembly.instantiate(module, {});
    const { memory, __indirect_function_table: table } = instance.exports;
    if (
      !(memory instanceof WebAssembly.Memory) ||
      !(table instanceof WebAssembly.Table)
    )
      throw new Error('libghostty-vt exports no memory or function table');
    return new GhosttyVtModule({
      memory,
      __indirect_function_table: table,
      all: instance.exports,
    });
  }

  /** Calls an exported C function by name. */
  call(name: string, ...args: (number | bigint)[]): number {
    const fn = this.exports.all[name];
    if (typeof fn !== 'function') throw new Error(`Missing export ${name}`);
    // C functions here return an int, a pointer or nothing (wasm i32 / void).
    return Number(fn(...args) ?? 0);
  }

  /** Calls and throws a {@link GhosttyVtError} unless it returned success. */
  check(name: string, ...args: (number | bigint)[]): void {
    const result = this.call(name, ...args);
    if (result !== GHOSTTY_SUCCESS) throw new GhosttyVtError(name, result);
  }

  private refresh(): void {
    const buffer = this.exports.memory.buffer;
    if (
      buffer !== this.cachedBuffer ||
      buffer.byteLength !== this.cachedBytes.byteLength
    ) {
      this.cachedBuffer = buffer;
      this.cachedBytes = new Uint8Array(buffer);
      this.cachedView = new DataView(buffer);
    }
  }

  /** The live linear memory as bytes. Never hold this across a call. */
  bytes(): Uint8Array {
    this.refresh();
    return this.cachedBytes;
  }

  /** The live linear memory as a little-endian DataView. Same rule. */
  data(): DataView {
    this.refresh();
    return this.cachedView;
  }

  alloc(length: number): number {
    if (length <= 0) throw new RangeError('alloc length must be positive');
    const ptr = this.call('ghostty_wasm_alloc', length);
    if (ptr === 0) throw new GhosttyVtError('ghostty_wasm_alloc', -1);
    return ptr;
  }

  /** Allocates and zeroes. */
  calloc(length: number): number {
    const ptr = this.alloc(length);
    this.bytes().fill(0, ptr, ptr + length);
    return ptr;
  }

  free(ptr: number, length: number): void {
    if (ptr) this.call('ghostty_wasm_free', ptr, length);
  }

  /**
   * Runs a constructor that writes an opaque handle into an out slot and
   * returns that handle.
   */
  construct(name: string, ...argsBeforeSlot: (number | bigint)[]): number {
    return this.constructWith(name, argsBeforeSlot, []);
  }

  constructWith(
    name: string,
    before: (number | bigint)[],
    after: (number | bigint)[],
  ): number {
    const slot = this.call('ghostty_wasm_alloc_opaque');
    if (slot === 0) throw new GhosttyVtError('ghostty_wasm_alloc_opaque', -1);
    try {
      this.check(name, ...before, slot, ...after);
      return this.call('ghostty_wasm_take_opaque', slot);
    } finally {
      this.call('ghostty_wasm_free_opaque', slot);
    }
  }

  writeBytes(ptr: number, source: Uint8Array): void {
    this.bytes().set(source, ptr);
  }

  /** Copies `length` bytes out of linear memory. */
  readBytes(ptr: number, length: number): Uint8Array {
    return this.bytes().slice(ptr, ptr + length);
  }

  readCString(ptr: number): string {
    const bytes = this.bytes();
    let end = ptr;
    while (bytes[end] !== 0) end += 1;
    return new TextDecoder().decode(bytes.subarray(ptr, end));
  }

  /**
   * Registers a host callback in the module's indirect function table and
   * returns its index, which is the C function pointer value.
   */
  addFunction(
    fn: (...args: number[]) => unknown,
    signature: WasmSignature,
  ): number {
    const key = `${signature.params.join(',')}>${signature.results.join(',')}`;
    let module = trampolineModules.get(key);
    if (!module) {
      module = new WebAssembly.Module(trampolineModuleBytes(signature));
      trampolineModules.set(key, module);
    }
    const instance = new WebAssembly.Instance(module, { t: { f: fn } });
    const table = this.exports.__indirect_function_table;
    const index = this.freeTableSlots.pop() ?? table.grow(1);
    const trampoline = instance.exports.f;
    if (typeof trampoline !== 'function')
      throw new Error('trampoline module exports no function');
    table.set(index, trampoline);
    return index;
  }

  removeFunction(index: number): void {
    this.exports.__indirect_function_table.set(index, null);
    this.freeTableSlots.push(index);
  }

  /** The module's own description of its ABI (`ghostty_type_json`). */
  typeManifest(): unknown {
    return JSON.parse(this.readCString(this.call('ghostty_type_json')));
  }
}
