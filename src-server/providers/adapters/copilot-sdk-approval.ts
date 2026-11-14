/**
 * How Station's approval mode answers the Copilot runtime's permission
 * requests (docs/decisions/copilot-sdk-engine.md).
 *
 * Every session is created with `permissionMode: 'manual'`, so the runtime's
 * own automatic modes (`assisted`, an LLM judge; `allow-all`) never answer for
 * Station. Each request the runtime raises reaches the SDK's
 * `onPermissionRequest`, and this module decides who answers it:
 *
 * - `ask`: Station allows a read inside the session's working directory;
 *   everything else goes to a person through Station's approval card.
 * - `auto`: as `ask`, and Station also allows a file write inside the working
 *   directory.
 *
 * "Inside" compares real paths (symlinks resolved) against the working
 * directory's real path, and needs the runtime's `resolvedPath`: a read or
 * write without one goes to a person. A request managed policy marks
 * (`managedApprovalRequired`) always goes to a person, in every mode.
 * - `never` (full access): Station allows every request. Applied only to a
 *   `host` session: the Copilot runtime gives Station no process sandbox to
 *   confine it with, so full access elsewhere applies `auto`, as it does for
 *   an ACP engine.
 *
 * Not governed by Station: approvals a person saved in the Copilot CLI itself
 * (for example "approve for this location"). The runtime applies them without
 * raising a request, so no Station mode can narrow them.
 *
 * Request shapes: `PermissionRequest` in `@github/copilot-sdk`
 * `dist/generated/session-events.d.ts` (1.0.32), mirrored in
 * github/copilot-sdk `nodejs/src/generated/session-events.ts`.
 */
import { realpathSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import type {
  PermissionRequest,
  PermissionRequestResult,
} from '@github/copilot-sdk';
import type {
  ApprovalMode,
  StationConfinement,
} from '@kontourai/station-contracts/provider';
import type { EngineToolKind } from '@kontourai/station-contracts/runtime-events';

export type CopilotAppliedApprovalMode = 'ask' | 'auto' | 'never';

/**
 * The mode a session applies for a requested one. Unlike an ACP engine, a
 * Copilot SDK session has no "engine decides" setting: with no requested mode
 * Station still answers every request, at the strictest mode.
 */
export function copilotAppliedApprovalMode(
  requested: ApprovalMode | undefined,
  confinement: StationConfinement | undefined,
): CopilotAppliedApprovalMode {
  if (requested === 'never') return confinement === 'host' ? 'never' : 'auto';
  if (requested === 'auto') return 'auto';
  return 'ask';
}

/**
 * The real path of `target` (absolute, or relative to `base`): every symlink
 * resolved, also for a file that does not exist yet, through its nearest
 * existing parent. `undefined` when it cannot be resolved for any reason
 * other than not existing, so the caller asks a person.
 */
export function copilotRealPath(
  target: string,
  base: string,
): string | undefined {
  const absolute = resolve(base, target);
  try {
    return realpathSync.native(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
    const parent = dirname(absolute);
    if (parent === absolute) return undefined;
    const real = copilotRealPath(parent, base);
    return real === undefined ? undefined : join(real, basename(absolute));
  }
}

function within(directory: string, real: string): boolean {
  const rel = relative(directory, real);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The real paths a read or write request touches, or `undefined` when they
 * cannot all be established. The runtime's `resolvedPath` (optional and
 * experimental in the SDK) is required: without it the request names a path
 * Station cannot tie to a file, so a person decides. A write also checks every
 * `fileEdits[].before/after.path`.
 */
function requestRealPaths(
  request: PermissionRequest,
  realCwd: string,
): string[] | undefined {
  if (request.kind !== 'read' && request.kind !== 'write') return undefined;
  if (!request.resolvedPath) return undefined;
  const named = [request.resolvedPath];
  if (request.kind === 'write')
    for (const edit of request.fileEdits ?? []) {
      if (edit.before) named.push(edit.before.path);
      if (edit.after) named.push(edit.after.path);
    }
  const real: string[] = [];
  for (const path of named) {
    const resolved = copilotRealPath(path, realCwd);
    if (resolved === undefined) return undefined;
    real.push(resolved);
  }
  return real;
}

/**
 * Whether the runtime requires a person for this request: managed policy
 * marks it on the request and, on newer runtimes, on the derived prompt the
 * SDK passes as the handler's second argument. Either marker routes the
 * request to a person, whatever the mode or any session grant.
 */
export function copilotManagedApprovalRequired(
  request: PermissionRequest,
  invocation?: { promptRequest?: unknown },
): boolean {
  const prompt = invocation?.promptRequest as
    | { managedApprovalRequired?: unknown }
    | undefined;
  return (
    request.managedApprovalRequired === true ||
    prompt?.managedApprovalRequired === true
  );
}

/** What a session's approval decisions are made against. */
export interface CopilotApprovalScope {
  /** The real path of the session's working directory. */
  realCwd: string;
  grants: ReadonlySet<string>;
}

/**
 * The key a person's "allow for this session" answer is remembered under, or
 * `undefined` when that answer is taken as a one-call allow. A shell grant
 * covers the exact command text only; an MCP grant one server's tool; a read
 * grant the real directory the file is in; a write grant writes inside the
 * working directory. A managed request never records a grant.
 */
export function copilotSessionGrantKey(
  request: PermissionRequest,
  realCwd: string,
  managed: boolean,
): string | undefined {
  if (managed) return undefined;
  switch (request.kind) {
    case 'shell':
      return `shell:${request.fullCommandText}`;
    case 'write':
      return 'write';
    case 'read': {
      const real = requestRealPaths(request, realCwd);
      return real?.length === 1 ? `read-dir:${dirname(real[0])}` : undefined;
    }
    case 'url':
      return `url:${request.url}`;
    case 'mcp':
      return `mcp:${request.serverName}/${request.toolName}`;
    default:
      return undefined;
  }
}

function readGranted(grants: ReadonlySet<string>, real: string): boolean {
  for (const grant of grants)
    if (grant.startsWith('read-dir:') && within(grant.slice(9), real))
      return true;
  return false;
}

/** Whether Station allows this request without asking a person. */
export function copilotModeAllows(
  mode: CopilotAppliedApprovalMode,
  request: PermissionRequest,
  scope: CopilotApprovalScope,
  managed: boolean,
): boolean {
  if (managed) return false;
  if (mode === 'never') return true;
  if (request.kind === 'read' || request.kind === 'write') {
    const real = requestRealPaths(request, scope.realCwd);
    if (!real) return false;
    const inside = real.every((path) => within(scope.realCwd, path));
    if (request.kind === 'read')
      return inside || real.every((path) => readGranted(scope.grants, path));
    // A write is allowed only inside the working directory, by `auto` or by
    // a person's session grant for writes.
    return inside && (mode === 'auto' || scope.grants.has('write'));
  }
  const grant = copilotSessionGrantKey(request, scope.realCwd, false);
  return grant !== undefined && scope.grants.has(grant);
}

const VIEW_TEXT_MAX_CHARS = 8_000;

function bounded(text: string): string {
  return text.length > VIEW_TEXT_MAX_CHARS
    ? `${text.slice(0, VIEW_TEXT_MAX_CHARS)}…`
    : text;
}

interface CopilotPermissionView {
  title: string;
  toolName: string;
  toolKind: EngineToolKind;
  toolInput: Record<string, unknown>;
}

/** What Station's approval card shows for a request. */
export function copilotPermissionView(
  request: PermissionRequest,
): CopilotPermissionView {
  switch (request.kind) {
    case 'shell':
      return {
        title: 'Run a command',
        toolName: 'shell',
        toolKind: 'execute',
        toolInput: {
          command: bounded(request.fullCommandText),
          intention: request.intention,
        },
      };
    case 'write':
      return {
        title: 'Edit a file',
        toolName: 'write',
        toolKind: 'edit',
        toolInput: {
          path: request.fileName,
          diff: bounded(request.diff),
          intention: request.intention,
        },
      };
    case 'read':
      return {
        title: 'Read a file',
        toolName: 'read',
        toolKind: 'read',
        toolInput: { path: request.path, intention: request.intention },
      };
    case 'url':
      return {
        title: 'Fetch a URL',
        toolName: 'url',
        toolKind: 'fetch',
        toolInput: { url: request.url, intention: request.intention },
      };
    case 'mcp':
      return {
        title: `Use ${request.serverName}: ${request.toolTitle}`,
        toolName: `${request.serverName}/${request.toolName}`,
        toolKind: request.readOnly ? 'read' : 'other',
        toolInput: {
          server: request.serverName,
          tool: request.toolName,
          ...(request.args !== undefined ? { arguments: request.args } : {}),
        },
      };
    case 'memory':
      return {
        title: 'Remember a fact',
        toolName: 'memory',
        toolKind: 'other',
        toolInput: { fact: bounded(request.fact) },
      };
    case 'custom-tool':
    case 'hook':
      return {
        title: `Use ${request.toolName}`,
        toolName: request.toolName,
        toolKind: 'other',
        toolInput: {},
      };
    default:
      return {
        title: `Allow a ${request.kind} request`,
        toolName: request.kind,
        toolKind: 'other',
        toolInput: {},
      };
  }
}

/** The SDK result for a person's answer. */
export function copilotPermissionResult(
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
): PermissionRequestResult {
  switch (decision) {
    case 'accept':
    case 'acceptForSession':
      // A session grant is remembered by Station (`copilotSessionGrantKey`),
      // never handed to the runtime as a wider rule of its own.
      return { kind: 'approve-once' };
    case 'decline':
      return { kind: 'reject' };
    case 'cancel':
      return { kind: 'user-not-available' };
  }
}
