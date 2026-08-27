/**
 * Private declaration operation for native Station tool calls.
 *
 * A declaration says only "this exact call explicitly named this result".
 * It is deliberately not a file-acquisition, transcript, inventory, or
 * Task-reference API.  The opaque handle is an internal hand-off token and
 * must be removed before ordinary tool output is persisted or sent to a
 * client.
 */
import crypto from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type {
  DeclaredOutputDescriptor,
  DeclaredSessionOutputRecord,
} from '@kontourai/station-contracts/session-output-declaration';
import { DECLARED_SESSION_OUTPUT_V1 } from '@kontourai/station-contracts/session-output-declaration';
import {
  currentNativeOutputCallScope,
  currentNativeOutputDeclarationOperation,
  type NativeOutputCallFacts,
  type NativeOutputCallScope,
  type NativeOutputGrantAuthority,
} from './native-output-turn-grant.js';

export const NATIVE_OUTPUT_DECLARATION_TOOL = 'declare_output';
export const NATIVE_OUTPUT_DECLARATION_MAX_PENDING = 256;
export const NATIVE_OUTPUT_DECLARATION_TTL_MS = 60_000;
export const NATIVE_OUTPUT_DECLARATION_MAX_FILE_BYTES = 5 * 1024 * 1024;

export type NativeOutputDeclarationInput = {
  label?: unknown;
  file?: { path?: unknown; mediaType?: unknown };
  pullRequest?: {
    provider?: unknown;
    host?: unknown;
    owner?: unknown;
    repository?: unknown;
    ref?: unknown;
    nativeId?: unknown;
  };
};

export type NativeOutputDeclarationToolResult = {
  declarationHandle: string;
};

/** The only declaration result that may cross back into an engine transcript. */
export type NativeOutputDeclarationPublicResult = {
  declared: true;
  kind: 'workspace-file' | 'pull-request';
  label?: string;
};

/**
 * A schema-level refusal returned before a native call can be bound.  It is
 * deliberately distinct from a declaration failure: malformed engine input
 * must not reach the operation's authority, capacity, workspace, or PR seams.
 */
export type NativeOutputDeclarationInputRefusal = {
  declared: false;
  reason: 'invalid-declaration-input';
};

export type NativeOutputTerminalAdmission = {
  handle: string;
  declaration: DeclaredSessionOutputRecord;
};

export interface NativeOutputDeclarationOperation {
  declare(
    scope: NativeOutputCallScope,
    input: NativeOutputDeclarationInput,
  ): Promise<NativeOutputDeclarationToolResult>;
  takeTerminalAdmissions(
    sessionId: string,
    turnId: string,
    eventId: string,
  ): NativeOutputTerminalAdmission[];
  commit(handles: readonly string[]): void;
  rollback(_handles: readonly string[]): void;
}

type Pending = {
  scope: NativeOutputCallScope;
  facts: NativeOutputCallFacts;
  expiresAt: number;
  declaration: Omit<DeclaredSessionOutputRecord, 'eventId'>;
};

type PullRequestIdentity = Extract<
  DeclaredOutputDescriptor,
  { kind: 'pull-request' }
>;

const boundedText = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/**
 * Parse the native tool's JSON-schema-shaped engine input into fresh data.
 *
 * This belongs before `runWithCurrentNativeOutputCall`: a malformed model or
 * provider callback is not a native declaration attempt and must not consume a
 * native call binding, enter the admission operation, or reserve capacity.
 */
export function parseNativeOutputDeclarationInput(
  value: unknown,
): NativeOutputDeclarationInput | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['label', 'file', 'pullRequest']))
    return undefined;
  const rawLabel = value.label;
  if (rawLabel !== undefined && typeof rawLabel !== 'string') return undefined;

  const hasFile = Object.hasOwn(value, 'file');
  const hasPullRequest = Object.hasOwn(value, 'pullRequest');
  if (hasFile === hasPullRequest) return undefined;

  if (hasFile) {
    const file = value.file;
    if (
      !isRecord(file) ||
      !hasOnlyKeys(file, ['path', 'mediaType']) ||
      typeof file.path !== 'string' ||
      (file.mediaType !== undefined && typeof file.mediaType !== 'string')
    )
      return undefined;
    return {
      ...(rawLabel === undefined ? {} : { label: rawLabel }),
      file: {
        path: file.path,
        ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
      },
    };
  }

  const pullRequest = value.pullRequest;
  if (
    !isRecord(pullRequest) ||
    !hasOnlyKeys(pullRequest, [
      'provider',
      'host',
      'owner',
      'repository',
      'ref',
      'nativeId',
    ]) ||
    typeof pullRequest.provider !== 'string' ||
    typeof pullRequest.host !== 'string' ||
    typeof pullRequest.owner !== 'string' ||
    typeof pullRequest.repository !== 'string' ||
    typeof pullRequest.ref !== 'string' ||
    typeof pullRequest.nativeId !== 'string'
  )
    return undefined;
  return {
    ...(rawLabel === undefined ? {} : { label: rawLabel }),
    pullRequest: {
      provider: pullRequest.provider,
      host: pullRequest.host,
      owner: pullRequest.owner,
      repository: pullRequest.repository,
      ref: pullRequest.ref,
      nativeId: pullRequest.nativeId,
    },
  };
}

export function invalidNativeOutputDeclarationInput(): NativeOutputDeclarationInputRefusal {
  return { declared: false, reason: 'invalid-declaration-input' };
}

function label(value: unknown): string | undefined {
  const candidate = boundedText(value, 240);
  return candidate &&
    [...candidate].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    ? candidate
    : undefined;
}

function inside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

async function readWorkspaceFile(input: {
  root: string;
  requestedPath: unknown;
  mediaType: unknown;
}): Promise<Extract<DeclaredOutputDescriptor, { kind: 'workspace-file' }>> {
  const requested = boundedText(input.requestedPath, 4096);
  if (!requested || isAbsolute(requested)) {
    throw new Error(
      'A declared output file must be one workspace-relative path.',
    );
  }
  const root = await realpath(input.root);
  const joined = resolve(root, requested);
  if (!inside(root, joined))
    throw new Error('Declared output file is outside the workspace.');
  // Open once with O_NOFOLLOW, then read and verify the very same descriptor.
  // Path-based stat/read after a precheck is an attacker-controlled swap gap.
  let descriptor: Awaited<ReturnType<typeof open>>;
  try {
    descriptor = await open(joined, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error('Declared output must be a regular workspace file.');
  }
  try {
    const before = await descriptor.stat();
    if (!before.isFile()) {
      throw new Error('Declared output must be a regular workspace file.');
    }
    if (before.size > NATIVE_OUTPUT_DECLARATION_MAX_FILE_BYTES) {
      throw new Error(
        'Declared output file exceeds the 5 MiB declaration limit.',
      );
    }
    const limit = NATIVE_OUTPUT_DECLARATION_MAX_FILE_BYTES + 1;
    const bytes = Buffer.allocUnsafe(Math.min(limit, Number(before.size) + 1));
    let offset = 0;
    while (offset < bytes.length) {
      const read = await descriptor.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const after = await descriptor.stat();
    if (
      offset > NATIVE_OUTPUT_DECLARATION_MAX_FILE_BYTES ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== after.mtimeMs ||
      offset !== before.size
    ) {
      throw new Error(
        'Declared output file changed while it was being declared.',
      );
    }
    // The pathname must still resolve to this exact opened regular file, and
    // its resolved target must stay inside the recorded workspace.
    const finalPath = await lstat(joined);
    const finalResolved = await realpath(joined);
    if (
      finalPath.isSymbolicLink() ||
      !finalPath.isFile() ||
      finalPath.dev !== before.dev ||
      finalPath.ino !== before.ino ||
      !inside(root, finalResolved) ||
      finalResolved !== joined
    ) {
      throw new Error(
        'Declared output file changed while it was being declared.',
      );
    }
    const relativePath = relative(root, joined);
    const mediaType = boundedText(input.mediaType, 160);
    return {
      kind: 'workspace-file',
      relativePath,
      digest: crypto
        .createHash('sha256')
        .update(bytes.subarray(0, offset))
        .digest('hex'),
      length: offset,
      ...(mediaType &&
      /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(mediaType)
        ? { mediaType }
        : {}),
    };
  } finally {
    await descriptor.close();
  }
}

function requestedPullRequest(
  value: NativeOutputDeclarationInput['pullRequest'],
): {
  provider: string;
  host: string;
  owner: string;
  repository: string;
  ref: string;
  nativeId: string;
} {
  const provider = boundedText(value?.provider, 128);
  const host = boundedText(value?.host, 512);
  const owner = boundedText(value?.owner, 256);
  const repository = boundedText(value?.repository, 256);
  const ref = boundedText(value?.ref, 512);
  const nativeId = boundedText(value?.nativeId, 512);
  if (!provider || !host || !owner || !repository || !ref || !nativeId) {
    throw new Error(
      'A declared pull request requires exact provider, host, repository, ref, and native id identity.',
    );
  }
  return { provider, host, owner, repository, ref, nativeId };
}

/** Build the operation at the orchestration seam, where workspace/PR authority lives. */
export function createNativeOutputDeclarationOperation(input: {
  authority: NativeOutputGrantAuthority;
  workspaceForCall: (facts: NativeOutputCallFacts) => string | undefined;
  /** Exact-provider/repository detail seam. It must not synthesize a branch/base. */
  readPullRequest?: (identity: {
    provider: string;
    host: string;
    owner: string;
    repository: string;
    ref: string;
    nativeId: string;
    facts: NativeOutputCallFacts;
  }) => Promise<PullRequestIdentity | null>;
  now?: () => number;
}): NativeOutputDeclarationOperation {
  const pending = new Map<string, Pending>();
  const reservations = new Map<NativeOutputCallScope, object>();
  const pendingByScope = new Map<NativeOutputCallScope, string>();
  const now = input.now ?? Date.now;
  const prune = () => {
    const at = now();
    for (const [handle, value] of pending) {
      if (value.expiresAt <= at) {
        pendingByScope.delete(value.scope);
        pending.delete(handle);
      }
    }
  };
  return {
    async declare(scope, declarationInput) {
      prune();
      if (
        pending.size + reservations.size >=
          NATIVE_OUTPUT_DECLARATION_MAX_PENDING ||
        reservations.has(scope) ||
        pendingByScope.has(scope)
      ) {
        throw new Error(
          'Output declaration capacity is full; no pending declaration was replaced.',
        );
      }
      // This reservation is intentionally before `admit`: checking the owner
      // lease is a callback and may reenter declare(). The slot therefore has
      // a concrete opaque owner before any such reentry can observe capacity.
      const reservation = {};
      reservations.set(scope, reservation);
      try {
        const facts = input.authority.admit(scope);
        if (!facts)
          throw new Error(
            'This native tool call is no longer authorized to declare an output.',
          );
        const hasFile = declarationInput.file !== undefined;
        const hasPullRequest = declarationInput.pullRequest !== undefined;
        if (hasFile === hasPullRequest) {
          throw new Error('Declare exactly one file or pull request output.');
        }
        // The reservation remains through all owner-controlled file/PR I/O.
        // The map identity is server-only, so a model cannot free or forge it.
        const descriptor = hasFile
          ? await (async () => {
              const root = input.workspaceForCall(facts);
              if (!root)
                throw new Error(
                  'This turn has no workspace binding for a file declaration.',
                );
              return readWorkspaceFile({
                root,
                requestedPath: declarationInput.file?.path,
                mediaType: declarationInput.file?.mediaType,
              });
            })()
          : await (async () => {
              if (!input.readPullRequest) {
                throw new Error(
                  'Pull-request declarations are unavailable: no exact repository identity reader is configured.',
                );
              }
              const requested = requestedPullRequest(
                declarationInput.pullRequest,
              );
              const result = await input.readPullRequest({
                ...requested,
                facts,
              });
              if (
                result?.kind !== 'pull-request' ||
                result.provider !== requested.provider ||
                result.host !== requested.host ||
                result.repository.owner !== requested.owner ||
                result.repository.name !== requested.repository ||
                result.ref !== requested.ref ||
                result.nativeId !== requested.nativeId
              ) {
                throw new Error(
                  'The pull request could not be read at the declared exact repository identity.',
                );
              }
              return result;
            })();
        // Recheck after I/O. A replacement/cancel/configuration change never
        // leaves a usable declaration in memory.
        const liveFacts = input.authority.admit(scope);
        if (
          !liveFacts ||
          liveFacts.threadId !== facts.threadId ||
          liveFacts.turnId !== facts.turnId ||
          liveFacts.callId !== facts.callId
        ) {
          throw new Error(
            'This native tool call is no longer authorized to declare an output.',
          );
        }
        const handle = crypto.randomUUID();
        pending.set(handle, {
          scope,
          facts,
          expiresAt: now() + NATIVE_OUTPUT_DECLARATION_TTL_MS,
          declaration: {
            version: DECLARED_SESSION_OUTPUT_V1,
            declarationId: crypto.randomUUID(),
            sessionId: facts.threadId,
            turnId: facts.turnId,
            toolCallId: facts.callId,
            declaredAt: new Date(now()).toISOString(),
            ...(label(declarationInput.label)
              ? { label: label(declarationInput.label) }
              : {}),
            descriptor,
          },
        });
        pendingByScope.set(scope, handle);
        return { declarationHandle: handle };
      } finally {
        if (reservations.get(scope) === reservation) reservations.delete(scope);
      }
    },
    takeTerminalAdmissions(sessionId, turnId, eventId) {
      prune();
      const result: NativeOutputTerminalAdmission[] = [];
      for (const [handle, value] of pending) {
        if (value.facts.threadId !== sessionId || value.facts.turnId !== turnId)
          continue;
        const live = input.authority.admit(value.scope);
        if (
          !live ||
          live.threadId !== sessionId ||
          live.turnId !== turnId ||
          live.callId !== value.facts.callId
        ) {
          pendingByScope.delete(value.scope);
          pending.delete(handle);
          continue;
        }
        result.push({
          handle,
          declaration: { ...value.declaration, eventId },
        });
      }
      return result;
    },
    commit(handles) {
      for (const handle of handles) {
        const item = pending.get(handle);
        if (item) pendingByScope.delete(item.scope);
        pending.delete(handle);
      }
    },
    rollback(_handles) {
      // Keep reservations for the same genuine call retry.  Only a later
      // durable terminal commit, expiry, or authority revocation clears them.
    },
  };
}

/** Native framework tool body. No model-provided call/session id is accepted. */
export async function declareCurrentNativeOutput(
  input: NativeOutputDeclarationInput,
): Promise<NativeOutputDeclarationToolResult> {
  const scope = currentNativeOutputCallScope();
  const operation = currentNativeOutputDeclarationOperation();
  if (!scope || !operation)
    throw new Error(
      'Output declaration is available only inside a genuine native Station tool call.',
    );
  return operation.declare(scope, input);
}

/**
 * The minimum private host seam.  It is registered alongside framework tools
 * rather than through station-control/MCP, because only the framework wrapper
 * has an authentic native call id.  Its result is intentionally the handle
 * alone; the relay extracts and strips that field before normal output paths.
 */
export function createNativeOutputDeclarationTool() {
  return {
    name: NATIVE_OUTPUT_DECLARATION_TOOL,
    description:
      'Explicitly declare one workspace file or pull request produced by this tool call.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', maxLength: 240 },
        file: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            mediaType: { type: 'string' },
          },
          required: ['path'],
        },
        pullRequest: {
          type: 'object',
          properties: {
            provider: { type: 'string' },
            host: { type: 'string' },
            owner: { type: 'string' },
            repository: { type: 'string' },
            ref: { type: 'string' },
            nativeId: { type: 'string' },
          },
          required: [
            'provider',
            'host',
            'owner',
            'repository',
            'ref',
            'nativeId',
          ],
        },
      },
      additionalProperties: false,
    },
    execute: (input: NativeOutputDeclarationInput) =>
      declareCurrentNativeOutput(input),
  };
}

/**
 * Keep the pending admission handle process-local. Volt feeds a tool result
 * into its next model step and memory, so returning its raw result leaks a
 * capability-shaped token even when later SSE projection strips it.
 */
export function publicNativeOutputDeclarationResult(
  input: NativeOutputDeclarationInput,
  result: unknown,
): NativeOutputDeclarationPublicResult | unknown {
  if (
    !result ||
    typeof result !== 'object' ||
    typeof (result as { declarationHandle?: unknown }).declarationHandle !==
      'string'
  )
    return result;
  const declaredLabel = label(input.label);
  return {
    declared: true,
    kind: input.file !== undefined ? 'workspace-file' : 'pull-request',
    ...(declaredLabel ? { label: declaredLabel } : {}),
  };
}

/** Remove the opaque hand-off token before an ordinary transcript/SSE path. */
export function stripOutputDeclarationHandle<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripOutputDeclarationHandle(item)) as T;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.entries(record)
    .filter(([key]) => key !== 'declarationHandle')
    .map(([key, nested]) => [key, stripOutputDeclarationHandle(nested)]);
  return Object.fromEntries(entries) as T;
}

export async function* stripOutputDeclarationHandles<T extends object>(
  source: AsyncIterable<T>,
): AsyncIterable<T> {
  for await (const chunk of source) {
    const record = chunk as Record<string, unknown>;
    if (!('output' in record)) {
      yield chunk;
      continue;
    }
    // This stream is public/transcript-facing. Only the dedicated native
    // tool's own result carries the private field; ordinary tool/user data is
    // untouched even if it happens to share that property name.
    if (record.toolName !== NATIVE_OUTPUT_DECLARATION_TOOL) {
      yield chunk;
      continue;
    }
    const output = stripOutputDeclarationHandle(record.output);
    yield output === record.output ? chunk : ({ ...record, output } as T);
  }
}
