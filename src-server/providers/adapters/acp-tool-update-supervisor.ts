import crypto from 'node:crypto';
import {
  acpToolUpdateSupervisorBytes,
  acpToolUpdateSupervisorOperations,
  acpToolUpdateSupervisorRetainedBytes,
  acpToolUpdateSupervisorUpdates,
} from '../../telemetry/metrics.js';
import type {
  CanonicalRuntimeEvent,
  ProviderSession,
} from '../adapter-shape.js';

/** ACP redraws are untrusted input, never a second event store. */
export const ACP_TOOL_UPDATE_LIMITS = {
  maxCallsPerSession: 64,
  maxCallsAdapter: 512,
  maxUpdatesPerCall: 10_000,
  maxTombstonesPerSession: 512,
  tombstoneTtlMs: 60_000,
  maxRetainedBytesPerCall: 8 * 1024,
  maxRetainedBytesPerSession: 64 * 8 * 1024,
  maxRetainedBytesAdapter: 512 * 8 * 1024,
  maxDepth: 4,
  maxProperties: 32,
  maxContentBlocks: 32,
  cadenceMs: 100,
} as const;

type ReceiptReason =
  | 'bytes'
  | 'blocks'
  | 'depth'
  | 'properties'
  | 'cycle'
  | 'getter'
  | 'updates'
  | 'unsupported';

/** Public shape carried by the canonical event contract. */
export type ToolOutputReceipt = {
  truncated: true;
  reasons: ReceiptReason[];
  retainedBytes: number;
  omittedBytesAtLeast: number;
  omittedUpdates: number;
  strategy: 'utf8-tail' | 'structural-omission';
  fullOutput: 'unavailable';
};

/** A typed, data-only ACP content projection; image bytes are never copied. */
export type AcpToolContentProjection = Array<
  | { type: 'text'; text: string }
  | { type: 'diff'; path: string; oldText?: string; newText: string }
  | { type: 'resource'; uri?: string; text?: string; mimeType?: string }
  | { type: 'image'; uri?: string; mimeType?: string; omitted: 'image-bytes' }
  | {
      type: 'omitted';
      reason: 'invalid' | 'unsupported' | 'limit' | 'unavailable';
    }
>;

export type AcpToolUpdate = {
  toolCallId: string;
  title?: string | null;
  name?: string | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
  status?: string | null;
  hasTitle?: boolean;
  hasName?: boolean;
  hasRawInput?: boolean;
  hasRawOutput?: boolean;
  hasContent?: boolean;
  hasStatus?: boolean;
};

type CallState = {
  name?: string;
  title?: string;
  hasRawInput: boolean;
  rawInput?: unknown;
  rawInputBytes: number;
  rawInputReceipt?: ToolOutputReceipt;
  hasRawOutput: boolean;
  rawOutput?: unknown;
  rawOutputBytes: number;
  rawOutputReceipt?: ToolOutputReceipt;
  hasContent: boolean;
  content?: AcpToolContentProjection;
  contentReceipt?: ToolOutputReceipt;
  contentBytes: number;
  updateCount: number;
  omittedUpdates: number;
  retainedBytes: number;
  pending?: CanonicalRuntimeEvent;
  lastPublishedAt?: number;
};

/** Adapter-wide capacity accounting. No caller or tool identifier is retained. */
export class AcpToolUpdateGlobalBudget {
  private sessions = 0;
  private calls = 0;
  private bytes = 0;

  acquireSession(): boolean {
    if (this.sessions >= ACP_TOOL_UPDATE_LIMITS.maxCallsPerSession)
      return false;
    this.sessions += 1;
    return true;
  }
  releaseSession(): void {
    this.sessions = Math.max(0, this.sessions - 1);
  }
  acquireCall(): boolean {
    if (this.calls >= ACP_TOOL_UPDATE_LIMITS.maxCallsAdapter) return false;
    this.calls += 1;
    return true;
  }
  releaseCall(bytes: number): void {
    this.calls = Math.max(0, this.calls - 1);
    this.bytes = Math.max(0, this.bytes - bytes);
  }
  replaceBytes(previous: number, next: number): boolean {
    const candidate = this.bytes - previous + next;
    if (candidate > ACP_TOOL_UPDATE_LIMITS.maxRetainedBytesAdapter)
      return false;
    this.bytes = Math.max(0, candidate);
    return true;
  }
}

const utf8 = (value: string) => Buffer.byteLength(value, 'utf8');

/** Retain the useful end without splitting a UTF-8 code point. */
function tailBytes(
  value: string,
  maximum: number,
): { value: string; omitted: number } {
  const total = utf8(value);
  if (total <= maximum) return { value, omitted: 0 };
  let used = 0;
  const tail: string[] = [];
  for (let index = value.length; index > 0; ) {
    const low = value.charCodeAt(index - 1);
    const isPair =
      low >= 0xdc00 &&
      low <= 0xdfff &&
      index > 1 &&
      value.charCodeAt(index - 2) >= 0xd800 &&
      value.charCodeAt(index - 2) <= 0xdbff;
    const point = value.codePointAt(index - (isPair ? 2 : 1));
    if (point === undefined) break;
    const width = isPair ? 2 : 1;
    index -= width;
    const unit = String.fromCodePoint(point);
    const size = utf8(unit);
    if (used + size > maximum) break;
    tail.push(unit);
    used += size;
  }
  return { value: tail.reverse().join(''), omitted: Math.max(0, total - used) };
}

function dataProperty(value: unknown, key: PropertyKey): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function'))
    return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeArrayEntries(value: unknown): {
  entries: unknown[];
  unavailable: boolean;
  isArray: boolean;
} {
  try {
    if (!Array.isArray(value))
      return { entries: [], unavailable: false, isArray: false };
    const length = dataProperty(value, 'length');
    if (
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 0
    )
      return { entries: [], unavailable: true, isArray: true };
    const entries: unknown[] = [];
    for (
      let index = 0;
      index < Math.min(length, ACP_TOOL_UPDATE_LIMITS.maxContentBlocks);
      index++
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      entries.push(
        descriptor && 'value' in descriptor ? descriptor.value : undefined,
      );
    }
    return { entries, unavailable: false, isArray: true };
  } catch {
    return { entries: [], unavailable: true, isArray: false };
  }
}

type RawProjection = {
  value?: unknown;
  bytes: number;
  receipt?: ToolOutputReceipt;
};

/**
 * Incrementally builds a JSON-safe raw-value projection. Every accepted
 * property is checked as encoded JSON, so braces, keys, commas, quotes and
 * array slots count against the same aggregate budget as their values.
 */
class BoundedStructuralProjector {
  private readonly reasons = new Set<ReceiptReason>();
  private readonly seen = new WeakSet<object>();
  private omittedBytes = 0;

  constructor(private readonly maximum: number) {}

  project(value: unknown): RawProjection {
    if (this.maximum <= 0) {
      this.omit('bytes', this.conservativeOmittedBytes(value));
      return { bytes: 0, receipt: this.receipt(0) };
    }
    let projected = this.walk(value, 0, undefined);
    let bytes = this.encodedBytes(projected);
    if (typeof value === 'string' && typeof projected === 'string') {
      let retained = projected;
      while (bytes !== undefined && bytes > this.maximum && retained) {
        retained = tailBytes(value, Math.max(0, utf8(retained) - 1)).value;
        bytes = this.encodedBytes(retained);
      }
      projected = retained;
      this.recordStringOmission(value, retained);
    }
    if (bytes === undefined || bytes > this.maximum) {
      this.omit('bytes', this.conservativeOmittedBytes(value));
      return { bytes: 0, receipt: this.receipt(0) };
    }
    return { value: projected, bytes, receipt: this.receipt(bytes) };
  }

  private walk(input: unknown, depth: number, container: unknown): unknown {
    if (typeof input === 'string') return this.stringTail(input, container);
    if (
      input === null ||
      typeof input === 'boolean' ||
      typeof input === 'number'
    )
      return input;
    if (
      typeof input === 'bigint' ||
      typeof input === 'symbol' ||
      typeof input === 'function'
    ) {
      this.omit('unsupported');
      return '[unavailable]';
    }
    if (typeof input !== 'object') {
      this.omit('unsupported');
      return '[unavailable]';
    }
    if (this.seen.has(input)) {
      this.omit('cycle');
      return '[Circular]';
    }
    if (depth >= ACP_TOOL_UPDATE_LIMITS.maxDepth) {
      this.omit('depth');
      return '[depth omitted]';
    }
    this.seen.add(input);
    let isArray: boolean;
    try {
      isArray = Array.isArray(input);
    } catch {
      this.omit('getter');
      return '[unavailable]';
    }
    const result: Record<string, unknown> | unknown[] = isArray ? [] : {};
    let keys: string[];
    try {
      keys = Object.keys(input);
    } catch {
      this.omit('getter');
      return '[unavailable]';
    }
    if (keys.length > ACP_TOOL_UPDATE_LIMITS.maxProperties)
      this.omit('properties');
    for (const key of keys.slice(0, ACP_TOOL_UPDATE_LIMITS.maxProperties)) {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(input, key);
      } catch {
        this.omit('getter');
        continue;
      }
      if (!descriptor || !('value' in descriptor)) {
        this.omit('getter');
        continue;
      }
      const candidate = this.walk(descriptor.value, depth + 1, result);
      (result as Record<string, unknown>)[key] = candidate;
      if (this.fits(result, container)) {
        this.recordStringOmission(descriptor.value, candidate);
        continue;
      }
      if (typeof descriptor.value === 'string') {
        const base = (result as Record<string, unknown>)[key];
        (result as Record<string, unknown>)[key] = '';
        const structuralBytes = this.encodedBytes(result) ?? this.maximum;
        const tail = tailBytes(
          descriptor.value,
          Math.max(0, this.maximum - structuralBytes),
        );
        (result as Record<string, unknown>)[key] = tail.value;
        if (this.fits(result, container)) {
          this.recordStringOmission(descriptor.value, tail.value);
          continue;
        }
        (result as Record<string, unknown>)[key] = base;
      }
      delete (result as Record<string, unknown>)[key];
      this.omit('bytes', this.conservativeOmittedBytes(descriptor.value));
      break;
    }
    return result;
  }

  private stringTail(value: string, _container: unknown): string {
    return tailBytes(value, this.maximum).value;
  }

  private recordStringOmission(source: unknown, retained: unknown): void {
    if (typeof source !== 'string' || typeof retained !== 'string') return;
    const omitted = utf8(source) - utf8(retained);
    if (omitted > 0) this.omit('bytes', omitted);
  }

  private fits(candidate: unknown, container: unknown): boolean {
    const bytes = this.encodedBytes(
      container === undefined ? candidate : container,
    );
    return bytes !== undefined && bytes <= this.maximum;
  }

  private encodedBytes(projected: unknown): number | undefined {
    try {
      const encoded = JSON.stringify(projected);
      return typeof encoded === 'string' ? utf8(encoded) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Never walks an omitted object: a lower bound is more useful than a trap. */
  private conservativeOmittedBytes(unvisited: unknown): number {
    if (typeof unvisited === 'string') return utf8(unvisited);
    if (typeof unvisited === 'number') {
      const numeric = unvisited;
      const encoded = JSON.stringify(numeric);
      return typeof encoded === 'string' ? utf8(encoded) : 0;
    }
    if (typeof unvisited === 'boolean') return unvisited ? 4 : 5;
    if (unvisited === null) return 4;
    return 0;
  }

  private omit(reason: ReceiptReason, bytes = 0): void {
    this.reasons.add(reason);
    this.omittedBytes += Math.max(0, bytes);
  }

  private receipt(retainedBytes: number): ToolOutputReceipt | undefined {
    if (!this.reasons.size) return undefined;
    return {
      truncated: true,
      reasons: [...this.reasons],
      retainedBytes,
      omittedBytesAtLeast: this.omittedBytes,
      omittedUpdates: 0,
      strategy: this.reasons.has('bytes') ? 'utf8-tail' : 'structural-omission',
      fullOutput: 'unavailable',
    };
  }
}

function projectRaw(value: unknown, maximum: number): RawProjection {
  return new BoundedStructuralProjector(maximum).project(value);
}

class ProjectionAccumulator {
  readonly reasons = new Set<ReceiptReason>();
  omittedBytes = 0;
  retainedBytes = 0;
  retain(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const bounded = tailBytes(
      value,
      Math.max(
        0,
        ACP_TOOL_UPDATE_LIMITS.maxRetainedBytesPerCall - this.retainedBytes,
      ),
    );
    if (bounded.omitted) this.omit('bytes', bounded.omitted);
    this.retainedBytes += utf8(bounded.value);
    return bounded.value;
  }
  omit(reason: ReceiptReason, bytes = 0): void {
    this.reasons.add(reason);
    this.omittedBytes += Math.max(0, bytes);
  }
  receipt(omittedUpdates = 0): ToolOutputReceipt | undefined {
    if (!this.reasons.size && omittedUpdates === 0) return undefined;
    if (omittedUpdates) this.reasons.add('updates');
    return {
      truncated: true,
      reasons: [...this.reasons],
      retainedBytes: this.retainedBytes,
      omittedBytesAtLeast: this.omittedBytes,
      omittedUpdates,
      strategy: this.reasons.has('bytes') ? 'utf8-tail' : 'structural-omission',
      fullOutput: 'unavailable',
    };
  }
}

function projectContent(content: unknown): {
  content: AcpToolContentProjection;
  receipt?: ToolOutputReceipt;
  bytes: number;
} {
  const accumulator = new ProjectionAccumulator();
  const array = safeArrayEntries(content);
  if (array.unavailable) {
    accumulator.omit('getter');
    return {
      content: [{ type: 'omitted', reason: 'unavailable' }],
      receipt: accumulator.receipt(),
      bytes: accumulator.retainedBytes,
    };
  }
  if (!array.isArray) {
    accumulator.omit('unsupported');
    return {
      content: [{ type: 'omitted', reason: 'invalid' }],
      receipt: accumulator.receipt(),
      bytes: accumulator.retainedBytes,
    };
  }
  const length = dataProperty(content, 'length');
  if (
    typeof length === 'number' &&
    length > ACP_TOOL_UPDATE_LIMITS.maxContentBlocks
  )
    accumulator.omit('blocks');
  const blocks: AcpToolContentProjection = [];
  for (const item of array.entries) {
    const type = dataProperty(item, 'type');
    if (type === 'content') {
      const nested = dataProperty(item, 'content');
      const nestedType = dataProperty(nested, 'type');
      if (nestedType === 'text')
        blocks.push({
          type: 'text',
          text: accumulator.retain(dataProperty(nested, 'text')) ?? '',
        });
      else if (nestedType === 'resource') {
        const resource = dataProperty(nested, 'resource');
        const uri = accumulator.retain(dataProperty(resource, 'uri'));
        const text = accumulator.retain(dataProperty(resource, 'text'));
        const mimeType = accumulator.retain(dataProperty(resource, 'mimeType'));
        blocks.push({
          type: 'resource',
          ...(uri === undefined ? {} : { uri }),
          ...(text === undefined ? {} : { text }),
          ...(mimeType === undefined ? {} : { mimeType }),
        });
      } else if (nestedType === 'image') {
        const uri = accumulator.retain(dataProperty(nested, 'uri'));
        const mimeType = accumulator.retain(dataProperty(nested, 'mimeType'));
        accumulator.omit('unsupported');
        blocks.push({
          type: 'image',
          ...(uri === undefined ? {} : { uri }),
          ...(mimeType === undefined ? {} : { mimeType }),
          omitted: 'image-bytes',
        });
      } else {
        accumulator.omit('unsupported');
        blocks.push({ type: 'omitted', reason: 'unsupported' });
      }
    } else if (type === 'diff') {
      const path =
        accumulator.retain(dataProperty(item, 'path')) ?? '[path omitted]';
      const oldText = accumulator.retain(dataProperty(item, 'oldText'));
      const newText = accumulator.retain(dataProperty(item, 'newText')) ?? '';
      blocks.push({
        type: 'diff',
        path,
        ...(oldText === undefined ? {} : { oldText }),
        newText,
      });
    } else if (type === 'resource') {
      const resource = dataProperty(item, 'resource');
      const uri = accumulator.retain(dataProperty(resource, 'uri'));
      const text = accumulator.retain(dataProperty(resource, 'text'));
      const mimeType = accumulator.retain(dataProperty(resource, 'mimeType'));
      blocks.push({
        type: 'resource',
        ...(uri === undefined ? {} : { uri }),
        ...(text === undefined ? {} : { text }),
        ...(mimeType === undefined ? {} : { mimeType }),
      });
    } else if (type === 'image') {
      const uri = accumulator.retain(dataProperty(item, 'uri'));
      const mimeType = accumulator.retain(dataProperty(item, 'mimeType'));
      accumulator.omit('unsupported');
      blocks.push({
        type: 'image',
        ...(uri === undefined ? {} : { uri }),
        ...(mimeType === undefined ? {} : { mimeType }),
        omitted: 'image-bytes',
      });
    } else {
      accumulator.omit('unsupported');
      blocks.push({ type: 'omitted', reason: 'unsupported' });
    }
  }
  return {
    content: blocks,
    receipt: accumulator.receipt(),
    bytes: accumulator.retainedBytes,
  };
}

function displayContent(
  content: AcpToolContentProjection | undefined,
): string | undefined {
  if (!content) return undefined;
  const joined = content
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'diff')
        return `${part.oldText === undefined ? 'New file' : 'Modified'}: ${part.path}\n${part.newText}`;
      if (part.type === 'resource')
        return part.text ?? part.uri ?? '[resource]';
      if (part.type === 'image')
        return part.uri ? `[image: ${part.uri}]` : '[image omitted]';
      return '[content omitted]';
    })
    .filter((part) => part.length > 0)
    .join('\n');
  return joined || undefined;
}

function receiptFor(call: CallState): ToolOutputReceipt | undefined {
  const sources = [
    call.rawInputReceipt,
    call.rawOutputReceipt,
    call.contentReceipt,
  ];
  if (!sources.some(Boolean) && call.omittedUpdates === 0) return undefined;
  const reasons = new Set<ReceiptReason>();
  for (const source of sources)
    source?.reasons.forEach((reason) => reasons.add(reason));
  if (call.omittedUpdates) reasons.add('updates');
  return {
    truncated: true,
    reasons: [...reasons],
    retainedBytes: call.retainedBytes,
    omittedBytesAtLeast: sources.reduce(
      (total, source) => total + (source?.omittedBytesAtLeast ?? 0),
      0,
    ),
    omittedUpdates: call.omittedUpdates,
    strategy: reasons.has('bytes') ? 'utf8-tail' : 'structural-omission',
    fullOutput: 'unavailable',
  };
}

/** One required cadence/replacement authority per ACP session. */
export class AcpToolUpdateSupervisor {
  private readonly calls = new Map<string, CallState>();
  private readonly tombstones = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private retainedBytes = 0;
  private readonly admitted: boolean;

  constructor(
    private readonly session: ProviderSession,
    private readonly publish: (event: CanonicalRuntimeEvent) => void,
    private readonly budget = new AcpToolUpdateGlobalBudget(),
    private readonly now = () => Date.now(),
  ) {
    this.admitted = budget.acquireSession();
  }

  acceptStarted(update: AcpToolUpdate): void {
    this.accept(update, true);
  }
  acceptUpdate(update: AcpToolUpdate): void {
    this.accept(update, false);
  }

  private accept(update: AcpToolUpdate, start: boolean): void {
    this.pruneTombstones();
    if (
      this.disposed ||
      !this.admitted ||
      this.tombstones.has(update.toolCallId)
    ) {
      this.observe('dropped');
      return;
    }
    let call = this.calls.get(update.toolCallId);
    if (!call) {
      if (
        this.calls.size >= ACP_TOOL_UPDATE_LIMITS.maxCallsPerSession ||
        !this.budget.acquireCall()
      ) {
        this.observe('call_limit');
        return;
      }
      call = {
        hasRawInput: false,
        rawInputBytes: 0,
        hasRawOutput: false,
        rawOutputBytes: 0,
        hasContent: false,
        contentBytes: 0,
        updateCount: 0,
        omittedUpdates: 0,
        retainedBytes: 0,
      };
      this.calls.set(update.toolCallId, call);
    }
    const terminal =
      update.status === 'completed' ||
      update.status === 'failed' ||
      update.status === 'cancelled';
    if (!start) call.updateCount += 1;
    if (
      call.updateCount > ACP_TOOL_UPDATE_LIMITS.maxUpdatesPerCall &&
      !terminal
    ) {
      call.omittedUpdates += 1;
      this.observe('update_limit');
      return;
    }
    const metadataChanged =
      start || update.hasName || update.hasTitle || update.hasRawInput;
    if (update.hasName)
      call.name = typeof update.name === 'string' ? update.name : undefined;
    if (update.hasTitle)
      call.title = typeof update.title === 'string' ? update.title : undefined;
    if (update.hasRawInput) {
      const rawInput =
        update.rawInput === null
          ? ({ value: undefined, bytes: 0 } satisfies RawProjection)
          : projectRaw(
              update.rawInput,
              ACP_TOOL_UPDATE_LIMITS.maxRetainedBytesPerCall -
                call.rawOutputBytes -
                call.contentBytes,
            );
      if (
        this.replaceRetained(
          call,
          rawInput.bytes + call.rawOutputBytes + call.contentBytes,
        )
      ) {
        call.hasRawInput = rawInput.value !== undefined;
        call.rawInput = rawInput.value;
        call.rawInputBytes = rawInput.bytes;
        call.rawInputReceipt = rawInput.receipt;
      } else {
        call.omittedUpdates += 1;
        this.observe('byte_limit');
      }
    }
    if (update.hasRawOutput) {
      const rawOutput =
        update.rawOutput === null
          ? ({ value: undefined, bytes: 0 } satisfies RawProjection)
          : projectRaw(
              update.rawOutput,
              ACP_TOOL_UPDATE_LIMITS.maxRetainedBytesPerCall -
                call.rawInputBytes -
                call.contentBytes,
            );
      if (
        this.replaceRetained(
          call,
          call.rawInputBytes + rawOutput.bytes + call.contentBytes,
        )
      ) {
        call.hasRawOutput = rawOutput.value !== undefined;
        call.rawOutput = rawOutput.value;
        call.rawOutputBytes = rawOutput.bytes;
        call.rawOutputReceipt = rawOutput.receipt;
      } else {
        call.omittedUpdates += 1;
        this.observe('byte_limit');
      }
    }
    if (update.hasContent) {
      if (update.content === null) {
        if (
          this.replaceRetained(call, call.rawInputBytes + call.rawOutputBytes)
        ) {
          call.hasContent = false;
          call.content = undefined;
          call.contentReceipt = undefined;
          call.contentBytes = 0;
        } else {
          call.omittedUpdates += 1;
          this.observe('byte_limit');
        }
      } else {
        const projected = projectContent(update.content);
        if (
          this.replaceRetained(
            call,
            call.rawInputBytes + call.rawOutputBytes + projected.bytes,
          )
        ) {
          call.hasContent = true;
          call.content = projected.content;
          call.contentReceipt = projected.receipt;
          call.contentBytes = projected.bytes;
          this.observe(projected.receipt ? 'truncated' : 'retained');
          this.observeBytes('retained', projected.bytes);
          if (projected.receipt)
            this.observeBytes('omitted', projected.receipt.omittedBytesAtLeast);
        } else {
          call.omittedUpdates += 1;
          this.observe('byte_limit');
        }
      }
    }
    if (metadataChanged) this.emitStarted(update.toolCallId, call);
    if (terminal) {
      this.flushCall(call);
      this.complete(update.toolCallId, call, update.status ?? 'failed');
      return;
    }
    // Metadata-only updates never invent a progress message.
    if (!update.hasContent || !call.hasContent) return;
    const message = displayContent(call.content);
    if (message) this.enqueue(update.toolCallId, call, message);
  }

  private replaceRetained(call: CallState, next: number): boolean {
    const candidate = this.retainedBytes - call.retainedBytes + next;
    if (
      candidate > ACP_TOOL_UPDATE_LIMITS.maxRetainedBytesPerSession ||
      !this.budget.replaceBytes(call.retainedBytes, next)
    )
      return false;
    this.retainedBytes = candidate;
    call.retainedBytes = next;
    return true;
  }
  private emitStarted(id: string, call: CallState): void {
    this.publish(
      this.event({
        method: 'tool.started',
        itemId: id,
        toolCallId: id,
        toolName: call.name || call.title || id,
        ...(call.hasRawInput ? { arguments: call.rawInput } : {}),
      }),
    );
  }
  private enqueue(id: string, call: CallState, message: string): void {
    const receipt = receiptFor(call);
    const event = this.event({
      method: 'tool.progress',
      itemId: id,
      toolCallId: id,
      message,
      ...(receipt ? { outputReceipt: receipt } : {}),
    });
    if (call.lastPublishedAt === undefined) {
      this.publish(event);
      this.observe('published');
      call.lastPublishedAt = this.now();
      return;
    }
    call.pending = event;
    this.observe('coalesced');
    this.schedule();
  }
  private complete(id: string, call: CallState, status: string): void {
    const output = call.hasContent
      ? call.content
      : call.hasRawOutput
        ? call.rawOutput
        : undefined;
    const receipt = receiptFor(call);
    this.publish(
      this.event({
        method: 'tool.completed',
        itemId: id,
        toolCallId: id,
        toolName: call.name || call.title || id,
        status:
          status === 'completed'
            ? 'success'
            : status === 'cancelled'
              ? 'cancelled'
              : 'error',
        ...(status === 'failed'
          ? { error: displayContent(call.content) }
          : output === undefined
            ? {}
            : { output }),
        ...(receipt ? { outputReceipt: receipt } : {}),
      }),
    );
    this.observe('terminal');
    this.releaseCall(id, call);
  }
  private releaseCall(id: string, call: CallState): void {
    this.calls.delete(id);
    this.retainedBytes = Math.max(0, this.retainedBytes - call.retainedBytes);
    this.budget.releaseCall(call.retainedBytes);
    this.tombstones.set(id, this.now() + ACP_TOOL_UPDATE_LIMITS.tombstoneTtlMs);
    this.pruneTombstones();
  }
  private schedule(): void {
    if (!this.timer)
      this.timer = setTimeout(
        () => this.flush(),
        ACP_TOOL_UPDATE_LIMITS.cadenceMs,
      );
  }
  private flushCall(call: CallState): void {
    if (!call.pending) return;
    this.publish(call.pending);
    this.observe('flush');
    call.pending = undefined;
    call.lastPublishedAt = this.now();
  }
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed) return;
    for (const call of this.calls.values()) this.flushCall(call);
  }
  /** Emits truthful bounded cancellations before teardown; synchronous by design. */
  cancelAll(): void {
    if (this.disposed) return;
    this.flush();
    for (const [id, call] of [...this.calls])
      this.complete(id, call, 'cancelled');
    this.observe('teardown');
  }
  dispose(): void {
    if (this.disposed) return;
    this.cancelAll();
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.tombstones.clear();
    if (this.admitted) this.budget.releaseSession();
  }
  private pruneTombstones(): void {
    const now = this.now();
    for (const [id, expiresAt] of this.tombstones)
      if (expiresAt <= now) this.tombstones.delete(id);
    while (
      this.tombstones.size > ACP_TOOL_UPDATE_LIMITS.maxTombstonesPerSession
    )
      this.tombstones.delete(this.tombstones.keys().next().value!);
  }
  private event(payload: Record<string, unknown>): CanonicalRuntimeEvent {
    return {
      eventId: crypto.randomUUID(),
      provider: 'acp',
      threadId: this.session.threadId,
      createdAt: new Date().toISOString(),
      ...payload,
    } as CanonicalRuntimeEvent;
  }
  private observe(
    outcome:
      | 'published'
      | 'terminal'
      | 'dropped'
      | 'call_limit'
      | 'update_limit'
      | 'byte_limit'
      | 'coalesced'
      | 'truncated'
      | 'retained'
      | 'flush'
      | 'teardown',
  ): void {
    try {
      acpToolUpdateSupervisorOperations.add(1, { outcome });
      acpToolUpdateSupervisorUpdates.add(1, { outcome });
    } catch {
      /* observation only */
    }
  }
  private observeBytes(outcome: 'retained' | 'omitted', bytes: number): void {
    try {
      acpToolUpdateSupervisorBytes.add(bytes, { outcome });
      acpToolUpdateSupervisorRetainedBytes.record(bytes, { scope: 'call' });
    } catch {
      /* observation only */
    }
  }
}
