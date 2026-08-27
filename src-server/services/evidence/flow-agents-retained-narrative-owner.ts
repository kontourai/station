/**
 * The one native Flow Agents retained-narrative convention understood by
 * Station. This is deliberately an adapter, not a directory discovery API:
 * callers supply a path-free ref and Station supplies the Project workspace.
 */
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  projectRetainedNarrativeProcess,
  readGroundedNarrative,
} from '@kontourai/flow-agents';
import {
  decodeGroundedNarrativeRef,
  decodeRetainedNarrativeProcessProjection,
  type GroundedNarrativeRef,
  type RetainedNarrativeProcessProjection,
} from '@kontourai/flow-agents/narrative-retained-codecs';
import { STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER } from '@kontourai/station-contracts/answer-narrative-binding';

export type ConfiguredNarrativeOwner = {
  ownerId: typeof STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER;
  projectId: string;
  workspacePath: string;
  narrativeDir: string;
  configurationFingerprint: string;
};

export type OwnerNarrativeRead =
  | {
      state: 'available';
      observedAt: string;
      process: RetainedNarrativeProcessProjection;
    }
  | {
      state:
        | 'not-captured'
        | 'unsupported-version'
        | 'corrupt'
        | 'unavailable'
        | 'restricted';
      observedAt: string;
    };

export interface RetainedNarrativeOwnerAdapter {
  capture(input: {
    ownerId: string;
    projectId: string;
    workspacePath: string;
    narrativeRef: GroundedNarrativeRef;
  }): ConfiguredNarrativeOwner | null;
  isCurrent(owner: ConfiguredNarrativeOwner): boolean;
  read(input: {
    owner: ConfiguredNarrativeOwner;
    narrativeRef: GroundedNarrativeRef;
    authorize(): boolean | Promise<boolean>;
  }): Promise<OwnerNarrativeRead>;
}

const LIMITS = {
  maxEnvelopeBytes: 1 * 1024 * 1024,
  maxManifestBytes: 1 * 1024 * 1024,
  maxSources: 128,
  maxSourceBytes: 1 * 1024 * 1024,
  maxAggregateSourceBytes: 8 * 1024 * 1024,
} as const;

export class FlowAgentsRetainedNarrativeOwner
  implements RetainedNarrativeOwnerAdapter
{
  constructor(
    private readonly resolveProjectWorkspace: (
      projectId: string,
    ) => string | undefined,
  ) {}

  capture(input: {
    ownerId: string;
    projectId: string;
    workspacePath: string;
    narrativeRef: GroundedNarrativeRef;
  }): ConfiguredNarrativeOwner | null {
    if (
      input.ownerId !== STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER ||
      !validId(input.projectId) ||
      !decodeGroundedNarrativeRef(input.narrativeRef)
    )
      return null;
    const resolved = this.resolveProjectWorkspace(input.projectId);
    // Publication asks this server-owned adapter to resolve the workspace;
    // persisted reads additionally prove the recorded workspace is still it.
    if (
      !resolved ||
      (input.workspacePath.length > 0 &&
        resolve(resolved) !== resolve(input.workspacePath))
    )
      return null;
    const workspacePath = resolve(resolved);
    // `narrativeId` has passed Flow Agents' public, path-free codec. It is
    // joined once as a segment; there is no parent/nested/latest fallback.
    const narrativeDir = join(
      workspacePath,
      '.kontourai',
      'narrative',
      input.narrativeRef.narrativeId,
    );
    return {
      ownerId: STATION_FLOW_AGENTS_PROJECT_NARRATIVE_OWNER,
      projectId: input.projectId,
      workspacePath,
      narrativeDir,
      configurationFingerprint: fingerprint(workspacePath),
    };
  }

  isCurrent(owner: ConfiguredNarrativeOwner): boolean {
    const workspace = this.resolveProjectWorkspace(owner.projectId);
    return (
      !!workspace &&
      resolve(workspace) === owner.workspacePath &&
      fingerprint(resolve(workspace)) === owner.configurationFingerprint
    );
  }

  async read(input: {
    owner: ConfiguredNarrativeOwner;
    narrativeRef: GroundedNarrativeRef;
    authorize(): boolean | Promise<boolean>;
  }): Promise<OwnerNarrativeRead> {
    const observedAt = new Date().toISOString();
    if (!this.isCurrent(input.owner) || !(await input.authorize()))
      return { state: 'restricted', observedAt };
    const ref = decodeGroundedNarrativeRef(input.narrativeRef);
    if (!ref) return { state: 'unsupported-version', observedAt };
    const retained = await readGroundedNarrative({
      scope: { narrativeDir: input.owner.narrativeDir },
      ref,
      limits: LIMITS,
      authorize: input.authorize,
    });
    if (retained.status !== 'available')
      return { state: mapUnavailable(retained.reason), observedAt };
    if (!this.isCurrent(input.owner) || !(await input.authorize()))
      return { state: 'restricted', observedAt };
    const process = projectRetainedNarrativeProcess(ref, retained.envelope);
    const checked =
      process && decodeRetainedNarrativeProcessProjection(process);
    return checked
      ? { state: 'available', observedAt, process: checked }
      : { state: 'corrupt', observedAt };
  }
}

function mapUnavailable(
  reason: string,
): Exclude<OwnerNarrativeRead['state'], 'available'> {
  switch (reason) {
    case 'unauthorized':
    case 'authorization_revoked':
      return 'restricted';
    case 'not_captured':
      return 'not-captured';
    case 'unsupported_version':
      return 'unsupported-version';
    case 'corrupt':
    case 'invalid_reference':
      return 'corrupt';
    default:
      return 'unavailable';
  }
}

function fingerprint(workspacePath: string): string {
  return createHash('sha256')
    .update(`station-flow-agents-project-narratives/v1\0${workspacePath}`)
    .digest('hex');
}

function validId(value: string): boolean {
  return (
    value.length > 0 &&
    wellFormedUnicode(value) &&
    Buffer.byteLength(value, 'utf8') <= 512
  );
}

function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
