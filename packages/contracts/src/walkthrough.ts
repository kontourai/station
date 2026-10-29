import type { ActionOperation } from './action-operation.js';

export const WALKTHROUGH_SCHEMA = 'station.walkthrough/v1' as const;
/** Refusals, never truncation. Text limits count UTF-16 code units. */
export const WALKTHROUGH_LIMITS = Object.freeze({
  durationMs: 30 * 60_000,
  events: 4096,
  frames: 120,
  text: 16_384,
  totalText: 262_144,
  tokens: 32_768,
  tokenText: 256,
  points: 2048,
  dimension: 16_384,
  manifestBytes: 8 * 1024 * 1024,
  uploadBytes: 512 * 1024 * 1024,
  frameBytes: 512 * 1024,
  frameEdge: 1280,
  listPage: 50,
  framePage: 4,
});
/** HTTP receive policy shared by admission, streaming owners and the UI proxy. */
export const MAX_TRANSCRIPTION_UPLOAD_BYTES = 32 * 1024 * 1024;
export const TRANSCRIPTION_UPLOAD_TIMEOUT_MS = 60_000;
export const MEDIA_UPLOAD_POLICIES = Object.freeze({
  walkthrough: {
    bytes: WALKTHROUGH_LIMITS.uploadBytes,
    idleMs: 60_000,
    totalMs: 2 * 60 * 60_000,
    responseMs: 2 * 60 * 60_000,
  },
  transcription: {
    bytes: MAX_TRANSCRIPTION_UPLOAD_BYTES,
    idleMs: 60_000,
    totalMs: TRANSCRIPTION_UPLOAD_TIMEOUT_MS,
    responseMs: 16 * 60_000,
  },
});
export function mediaUploadPolicy(
  method: string,
  path: string,
  policies: typeof MEDIA_UPLOAD_POLICIES,
) {
  if (method !== 'POST') return undefined;
  if (/^\/api\/projects\/[^/]+\/walkthroughs\/import$/.test(path))
    return policies.walkthrough;
  if (path === '/api/transcription') return policies.transcription;
  return undefined;
}
export const WALKTHROUGH_CHANNELS = [
  'transcript',
  'frames',
  'marks',
  'elements',
  'route',
  'console',
  'network',
] as const;
export type WalkthroughChannel = (typeof WALKTHROUGH_CHANNELS)[number];
export type FrameReason = 'scene-change' | 'deictic' | 'pause' | 'interval';
export interface ElementRef {
  testId?: string;
  selector?: string;
  component?: string;
  source?: { file: string; line?: number };
}
export interface WalkthroughToken {
  tMs: number;
  endMs: number;
  text: string;
}
export type WalkthroughEvent =
  | {
      kind: 'transcript';
      tMs: number;
      endMs: number;
      text: string;
      tokens?: WalkthroughToken[];
    }
  | {
      kind: 'frame';
      tMs: number;
      frameId: string;
      file: string;
      width: number;
      height: number;
      reasons: FrameReason[];
    }
  | {
      kind: 'mark';
      tMs: number;
      shape: 'tap' | 'circle' | 'arrow' | 'rect' | 'stroke';
      points: [number, number][];
      frameId?: string;
      element?: ElementRef;
    }
  | { kind: 'route'; tMs: number; path: string }
  | { kind: 'console'; tMs: number; level: 'error' | 'warn'; message: string }
  | {
      kind: 'network';
      tMs: number;
      method: string;
      url: string;
      status: number;
    };
export type WalkthroughFrame = Extract<WalkthroughEvent, { kind: 'frame' }>;
export type WalkthroughTranscript = Extract<
  WalkthroughEvent,
  { kind: 'transcript' }
>;
export interface Walkthrough {
  schema: typeof WALKTHROUGH_SCHEMA;
  id: string;
  createdAt: string;
  title?: string;
  source: {
    adapter: string;
    adapterVersion: string;
    originalName?: string;
    durationMs: number;
  };
  capture: {
    platform: 'desktop' | 'web' | 'ios' | 'android' | 'unknown';
    width?: number;
    height?: number;
  };
  coverage: Record<WalkthroughChannel, 'present' | 'absent'>;
  frameSelection?: { candidates: number; kept: number };
  events: WalkthroughEvent[];
}
export type WalkthroughUnavailable =
  | {
      status: 'unavailable';
      reason: 'needs-consent';
      downloads: readonly {
        component: string;
        version: string;
        bytes: number;
      }[];
    }
  | { status: 'unavailable'; reason: 'unsupported-platform'; platform: string };
export type WalkthroughImportOutcome =
  | { status: 'imported'; id: string }
  | WalkthroughUnavailable
  | { status: 'failed'; reason: string };
export interface WalkthroughImportStatus {
  operation: ActionOperation;
  outcome?: WalkthroughImportOutcome;
}
export interface WalkthroughSummary {
  id: string;
  createdAt: string;
  title?: string;
  durationMs: number;
  frames: number;
}
export interface WalkthroughPage {
  items: WalkthroughSummary[];
  nextCursor?: string;
}

export class WalkthroughValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalkthroughValidationError';
  }
}
function refuse(message: string): never {
  throw new WalkthroughValidationError(message);
}
function record(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    return refuse('Expected object');
  return v as Record<string, unknown>;
}
function fields(v: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(v).some((k) => !allowed.includes(k))) refuse('Unknown field');
}
function text(v: unknown, max: number = WALKTHROUGH_LIMITS.text): string {
  if (typeof v !== 'string' || v.length > max || v.includes('\0'))
    return refuse('Text length limit or invalid text');
  return v;
}
function number(v: unknown, max: number, min = 0): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    return refuse('Number out of bounds');
  return v;
}
function integer(v: unknown, max: number, min = 0): number {
  const n = number(v, max, min);
  if (!Number.isSafeInteger(n)) refuse('Expected integer');
  return n;
}
export function isWalkthroughId(v: unknown): v is string {
  return typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(v);
}
function id(v: unknown): string {
  if (!isWalkthroughId(v)) return refuse('Invalid id');
  return v;
}
export function isWalkthroughFileName(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= 240 &&
    v !== '.' &&
    !v.includes('..') &&
    !/[/\\:]/u.test(v) &&
    ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    !/[. ]$/.test(v)
  );
}
function filename(v: unknown): string {
  if (!isWalkthroughFileName(v)) return refuse('Expected plain file name');
  return v;
}
function choice<T extends string>(v: unknown, values: readonly T[]): T {
  for (const item of values) if (v === item) return item;
  return refuse('Invalid choice');
}
function array(v: unknown, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max) return refuse('Array count limit');
  return v;
}
function element(v: unknown): ElementRef {
  const r = record(v);
  fields(r, ['testId', 'selector', 'component', 'source']);
  const result: ElementRef = {};
  for (const key of ['testId', 'selector', 'component'] as const)
    if (r[key] !== undefined) result[key] = text(r[key]);
  if (r.source !== undefined) {
    const s = record(r.source);
    fields(s, ['file', 'line']);
    result.source = {
      file: text(s.file),
      ...(s.line === undefined ? {} : { line: integer(s.line, 1_000_000, 1) }),
    };
  }
  return result;
}
/** Strict boundary parser: throws WalkthroughValidationError on every refusal. */
export function parseWalkthrough(value: unknown): Walkthrough {
  const r = record(value);
  fields(r, [
    'schema',
    'id',
    'createdAt',
    'title',
    'source',
    'capture',
    'coverage',
    'frameSelection',
    'events',
  ]);
  if (r.schema !== WALKTHROUGH_SCHEMA) refuse('Unsupported schema');
  const createdAt = text(r.createdAt, 64);
  if (
    !/^\d{4}-\d\d-\d\dT/.test(createdAt) ||
    !Number.isFinite(Date.parse(createdAt))
  )
    refuse('Invalid createdAt');
  const s = record(r.source);
  fields(s, ['adapter', 'adapterVersion', 'originalName', 'durationMs']);
  const durationMs = number(s.durationMs, WALKTHROUGH_LIMITS.durationMs, 1);
  const c = record(r.capture);
  fields(c, ['platform', 'width', 'height']);
  const coverageRecord = record(r.coverage);
  fields(coverageRecord, [...WALKTHROUGH_CHANNELS]);
  const coverage = {} as Walkthrough['coverage'];
  for (const channel of WALKTHROUGH_CHANNELS)
    coverage[channel] = choice(coverageRecord[channel], ['present', 'absent']);
  let tokenCount = 0,
    textCount = 0,
    lastTime = -1;
  const boundedText = (v: unknown, max: number = WALKTHROUGH_LIMITS.text) => {
    const result = text(v, max);
    textCount += result.length;
    if (textCount > WALKTHROUGH_LIMITS.totalText) refuse('Total text limit');
    return result;
  };
  const events = array(r.events, WALKTHROUGH_LIMITS.events).map(
    (v): WalkthroughEvent => {
      const e = record(v);
      const tMs = number(e.tMs, durationMs);
      if (tMs < lastTime) refuse('Events must be ordered by tMs');
      lastTime = tMs;
      const channel =
        e.kind === 'frame'
          ? 'frames'
          : e.kind === 'mark'
            ? 'marks'
            : choice(e.kind, ['transcript', 'route', 'console', 'network']);
      if (coverage[channel] === 'absent') refuse(`Absent channel: ${channel}`);
      if (e.kind === 'transcript') {
        fields(e, ['kind', 'tMs', 'endMs', 'text', 'tokens']);
        const endMs = number(e.endMs, durationMs, tMs);
        let previous = tMs;
        const tokens =
          e.tokens === undefined
            ? undefined
            : array(e.tokens, WALKTHROUGH_LIMITS.tokens).map((v) => {
                const t = record(v);
                fields(t, ['tMs', 'endMs', 'text']);
                const start = number(t.tMs, endMs, previous);
                previous = start;
                tokenCount++;
                if (tokenCount > WALKTHROUGH_LIMITS.tokens)
                  refuse('Token count limit');
                return {
                  tMs: start,
                  endMs: number(t.endMs, endMs, start),
                  text: boundedText(t.text, WALKTHROUGH_LIMITS.tokenText),
                };
              });
        return {
          kind: 'transcript',
          tMs,
          endMs,
          text: boundedText(e.text),
          ...(tokens === undefined ? {} : { tokens }),
        };
      }
      if (e.kind === 'frame') {
        fields(e, [
          'kind',
          'tMs',
          'frameId',
          'file',
          'width',
          'height',
          'reasons',
        ]);
        const reasons = array(e.reasons, 4).map((v) =>
          choice<FrameReason>(v, [
            'scene-change',
            'deictic',
            'pause',
            'interval',
          ]),
        );
        if (!reasons.length || new Set(reasons).size !== reasons.length)
          refuse('Invalid frame reasons');
        return {
          kind: 'frame',
          tMs,
          frameId: id(e.frameId),
          file: filename(e.file),
          width: integer(e.width, WALKTHROUGH_LIMITS.dimension, 1),
          height: integer(e.height, WALKTHROUGH_LIMITS.dimension, 1),
          reasons,
        };
      }
      if (e.kind === 'mark') {
        fields(e, ['kind', 'tMs', 'shape', 'points', 'frameId', 'element']);
        if (e.element !== undefined && coverage.elements === 'absent')
          refuse('Absent channel: elements');
        const points = array(e.points, WALKTHROUGH_LIMITS.points).map(
          (v): [number, number] => {
            const pair = array(v, 2);
            if (pair.length !== 2) refuse('Expected point pair');
            return [number(pair[0], 1), number(pair[1], 1)];
          },
        );
        if (!points.length) refuse('Mark requires points');
        return {
          kind: 'mark',
          tMs,
          shape: choice(e.shape, ['tap', 'circle', 'arrow', 'rect', 'stroke']),
          points,
          ...(e.frameId === undefined ? {} : { frameId: id(e.frameId) }),
          ...(e.element === undefined ? {} : { element: element(e.element) }),
        };
      }
      if (e.kind === 'route') {
        fields(e, ['kind', 'tMs', 'path']);
        return { kind: 'route', tMs, path: boundedText(e.path) };
      }
      if (e.kind === 'console') {
        fields(e, ['kind', 'tMs', 'level', 'message']);
        return {
          kind: 'console',
          tMs,
          level: choice(e.level, ['error', 'warn']),
          message: boundedText(e.message),
        };
      }
      fields(e, ['kind', 'tMs', 'method', 'url', 'status']);
      return {
        kind: 'network',
        tMs,
        method: boundedText(e.method, 32),
        url: boundedText(e.url),
        status: integer(e.status, 599),
      };
    },
  );
  const frames = events.filter(
    (e): e is WalkthroughFrame => e.kind === 'frame',
  );
  if (frames.length > WALKTHROUGH_LIMITS.frames) refuse('Frame count limit');
  if (
    new Set(frames.map((f) => f.frameId)).size !== frames.length ||
    new Set(frames.map((f) => f.file)).size !== frames.length
  )
    refuse('Duplicate frame');
  const frameIds = new Set(frames.map((f) => f.frameId));
  for (const event of events)
    if (
      event.kind === 'mark' &&
      event.frameId !== undefined &&
      !frameIds.has(event.frameId)
    )
      refuse('Unknown mark frameId');
  let frameSelection: Walkthrough['frameSelection'];
  if (r.frameSelection !== undefined) {
    const f = record(r.frameSelection);
    fields(f, ['candidates', 'kept']);
    frameSelection = {
      candidates: integer(f.candidates, 100_000),
      kept: integer(f.kept, WALKTHROUGH_LIMITS.frames),
    };
    if (
      frameSelection.kept !== frames.length ||
      frameSelection.candidates < frameSelection.kept
    )
      refuse('Invalid frameSelection');
  }
  const manifest: Walkthrough = {
    schema: WALKTHROUGH_SCHEMA,
    id: id(r.id),
    createdAt,
    ...(r.title === undefined ? {} : { title: text(r.title, 240) }),
    source: {
      adapter: text(s.adapter, 128),
      adapterVersion: text(s.adapterVersion, 128),
      durationMs,
      ...(s.originalName === undefined
        ? {}
        : { originalName: filename(s.originalName) }),
    },
    capture: {
      platform: choice(c.platform, [
        'desktop',
        'web',
        'ios',
        'android',
        'unknown',
      ]),
      ...(c.width === undefined
        ? {}
        : { width: integer(c.width, WALKTHROUGH_LIMITS.dimension, 1) }),
      ...(c.height === undefined
        ? {}
        : { height: integer(c.height, WALKTHROUGH_LIMITS.dimension, 1) }),
    },
    coverage,
    ...(frameSelection ? { frameSelection } : {}),
    events,
  };
  if (
    new TextEncoder().encode(JSON.stringify(manifest)).byteLength >
    WALKTHROUGH_LIMITS.manifestBytes
  )
    refuse('Manifest byte limit');
  return manifest;
}
