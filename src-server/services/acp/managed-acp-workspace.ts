import { resolveHomeDir } from '../../utils/paths.js';
import {
  isManagedEngineWorkspace,
  type ManagedEngineWorkspaceIdentity,
  prepareManagedEngineWorkspace,
} from '../infra/managed-engine-workspace.js';

/** Recognize ACP workspaces without claiming another engine's directories. */
export function isManagedAcpWorkspace(
  cwd: string,
  stationHome: string = resolveHomeDir(),
): boolean {
  return isManagedEngineWorkspace(cwd, stationHome, 'acp');
}

export async function prepareManagedAcpWorkspace(
  identity: ManagedEngineWorkspaceIdentity,
  stationHome: string = resolveHomeDir(),
): Promise<string> {
  return await prepareManagedEngineWorkspace('acp', identity, stationHome);
}
