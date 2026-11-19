import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk/unstable';
import { redactSecrets } from '@kontourai/station-shared/redaction';
import { secretLookingPathReason } from '../../services/projects/git-guards.js';
import { isRecord } from '../../utils/is-record.js';

const READ_KINDS = new Map<string, 'read' | 'search'>([
  ['read_file', 'read'],
  ['list_directory', 'read'],
  ['file_search', 'search'],
  ['grep_search', 'search'],
]);

function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !/\p{Cc}/u.test(value)
    ? value
    : undefined;
}

export function readKiroPermission(params: RequestPermissionRequest) {
  const kiro = params._meta?.kiro;
  if (!isRecord(kiro)) return undefined;
  const toolId = boundedText(kiro.toolId, 512);
  const consent = isRecord(kiro.consent) ? kiro.consent : undefined;
  const capability = consent?.capability;
  const resource = boundedText(consent?.resource, 4096);
  const mcp = isRecord(kiro.mcpTool) ? kiro.mcpTool.identity : undefined;
  const server = isRecord(mcp) ? boundedText(mcp.serverName, 512) : undefined;
  const tool = isRecord(mcp) ? boundedText(mcp.toolName, 512) : undefined;
  const remoteBuiltin =
    server === 'remote' &&
    tool === 'web_search' &&
    toolId === 'remote_web_search';
  const native = kiro.mcpTool === undefined;
  // An MCP identity is still self-reported. It cannot qualify as a local read
  // or acquire a built-in grant by presenting the same tool id.
  const toolName =
    native || remoteBuiltin
      ? (toolId ??
        (kiro.toolId === undefined
          ? (params.toolCall?.name ?? undefined)
          : undefined))
      : server && tool && !server.includes('__') && !tool.includes('__')
        ? `mcp__${server}__${tool}`
        : undefined;
  const kind =
    capability === 'fs_write'
      ? toolId === 'delete_file'
        ? 'delete'
        : 'edit'
      : capability === 'shell'
        ? 'execute'
        : capability === 'fs_read' && native && toolId
          ? READ_KINDS.get(toolId)
          : undefined;
  const shellCommand =
    capability === 'shell' &&
    typeof consent?.resource === 'string' &&
    consent.resource.length <= 4096 &&
    !consent.resource.includes(String.fromCharCode(0))
      ? consent.resource
      : undefined;
  const args =
    capability === 'shell' && shellCommand !== undefined
      ? { command: shellCommand }
      : resource !== undefined &&
          (capability === 'fs_write' || capability === 'fs_read')
        ? { path: resource }
        : undefined;
  return {
    toolName,
    kind,
    args,
    persistencePath: capability === 'fs_write' ? resource : undefined,
    explicit:
      !toolName ||
      (capability === 'fs_write' && !resource) ||
      (capability === 'shell' && !shellCommand) ||
      consent?.askType === 'explicit' ||
      consent?.matchedRule !== undefined ||
      consent?.scope !== undefined,
    workspaceRead:
      native &&
      capability === 'fs_read' &&
      toolId &&
      READ_KINDS.has(toolId) &&
      consent?.askType === 'implicit' &&
      resource &&
      typeof consent.workspaceRoot === 'string'
        ? { resource, root: consent.workspaceRoot, toolId }
        : undefined,
  };
}

function inside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    !isAbsolute(fromRoot) &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`)
  );
}

function sensitive(candidate: string): boolean {
  const normalized = candidate.replaceAll('\\', '/').toLowerCase();
  return (
    !!secretLookingPathReason(normalized) ||
    normalized
      .split('/')
      .some((segment) =>
        [
          '.aws',
          '.azure',
          '.config',
          '.gnupg',
          '.kube',
          '.ssh',
          '.station',
        ].includes(segment),
      )
  );
}

export async function isKiroWorkspaceRead(
  read: NonNullable<ReturnType<typeof readKiroPermission>>['workspaceRead'],
  cwd: string,
): Promise<boolean> {
  if (!read || !isAbsolute(read.root)) return false;
  const resource =
    sep === '\\' ? read.resource.replaceAll('\\', '/') : read.resource;
  const pathWithoutDrive =
    sep === '\\' ? resource.replace(/^[a-z]:/i, '') : resource;
  if (
    /[\\:*?[\]{}~$&;|<>()'"!%`]/u.test(pathWithoutDrive) ||
    resource.split('/').includes('..')
  )
    return false;
  try {
    const workspace = await realpath(cwd);
    if ((await realpath(read.root)) !== workspace) return false;
    const candidate = resolve(cwd, read.resource);
    if (!inside(resolve(cwd), candidate) || sensitive(candidate)) return false;
    const target = await realpath(candidate);
    if (!inside(workspace, target) || sensitive(target)) return false;
    const info = await stat(target);
    return read.toolId === 'read_file' ? info.isFile() : info.isDirectory();
  } catch {
    return false;
  }
}

export function kiroPermissionRefusal(
  outcome: RequestPermissionResponse['outcome'],
  params: RequestPermissionRequest,
  reason: string,
): RequestPermissionResponse {
  if (
    outcome.outcome !== 'selected' ||
    !params.options.some(
      (option) =>
        option.kind === 'reject_once' && option.optionId === outcome.optionId,
    )
  )
    return { outcome };
  const rejectionReason = redactSecrets(reason)
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
    .slice(0, 1000);
  return rejectionReason
    ? { outcome, _meta: { kiro: { rejectionReason } } }
    : { outcome };
}
