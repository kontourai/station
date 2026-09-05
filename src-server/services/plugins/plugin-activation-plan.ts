import { createHash } from 'node:crypto';
import type { PluginManifest } from '@kontourai/station-contracts/plugin';
import {
  isCanonicalPluginId,
  type PluginInstallationRevision,
} from '@kontourai/station-contracts/plugin';
import type { PluginInstallConsent } from './plugin-install-consent.js';
import type { PluginDependencyOwnershipEntry } from './plugin-permissions.js';

/** Recovery evidence contains declarations and ownership, never secret values,
 * package paths, process output, or a permission to replay old consent. */
export interface PluginActivationPlan {
  version: 1;
  artifactDigest: string;
  origin: string;
  descriptorDigest: string;
  sourceDigest: string;
  consent: PluginInstallConsent;
  previous: PluginInstallationRevision | null;
  parent?: { installation: string; generation: string };
  agents: Array<{ slug: string; previousProject: string | null }>;
  ownedDependencies: PluginDependencyOwnershipEntry[];
}
const DIGEST = /^sha256:[0-9a-f]{64}$/;
function strings(
  value: unknown,
  limit: number,
  maximum: number,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= limit &&
    value.every((entry) => typeof entry === 'string' && entry.length <= maximum)
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function opaque(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    Array.from(value).every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    )
  );
}
function optionalRevision(value: unknown): boolean {
  return value === undefined || opaque(value);
}
function validConsent(value: unknown): boolean {
  if (!object(value)) return false;
  if (value.kind === 'no-operator-decision')
    return (
      keys(value, ['kind', 'caller']) &&
      typeof value.caller === 'string' &&
      value.caller.length <= 256
    );
  if (
    !keys(value, [
      'kind',
      'permissions',
      'contentDigest',
      'dependencies',
      'dependencyApprovals',
      'grantRevision',
    ]) ||
    value.kind !== 'operator-decision' ||
    !optionalRevision(value.grantRevision) ||
    typeof value.contentDigest !== 'string' ||
    !DIGEST.test(value.contentDigest) ||
    !strings(value.permissions, 64, 128) ||
    !strings(value.dependencies, 256, 64) ||
    !value.dependencies.every(isCanonicalPluginId)
  )
    return false;
  return (
    value.dependencyApprovals === undefined ||
    (Array.isArray(value.dependencyApprovals) &&
      value.dependencyApprovals.length <= 256 &&
      value.dependencyApprovals.every(
        (approval) =>
          object(approval) &&
          keys(approval, [
            'id',
            'contentDigest',
            'permissions',
            'dependencies',
            'grantRevision',
          ]) &&
          optionalRevision(approval.grantRevision) &&
          typeof approval.id === 'string' &&
          isCanonicalPluginId(approval.id) &&
          typeof approval.contentDigest === 'string' &&
          DIGEST.test(approval.contentDigest) &&
          strings(approval.permissions, 64, 128) &&
          strings(approval.dependencies, 256, 64) &&
          approval.dependencies.every(isCanonicalPluginId),
      ))
  );
}
export function validPluginActivationPlan(
  value: unknown,
): value is PluginActivationPlan {
  if (
    !object(value) ||
    !keys(value, [
      'version',
      'artifactDigest',
      'origin',
      'descriptorDigest',
      'sourceDigest',
      'consent',
      'previous',
      'agents',
      'ownedDependencies',
      'parent',
    ]) ||
    value.version !== 1 ||
    !['artifactDigest', 'descriptorDigest', 'sourceDigest'].every(
      (key) =>
        typeof value[key] === 'string' && DIGEST.test(value[key] as string),
    ) ||
    typeof value.origin !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.origin) ||
    (value.parent !== undefined &&
      (!object(value.parent) ||
        !keys(value.parent, ['installation', 'generation']) ||
        typeof value.parent.installation !== 'string' ||
        !isCanonicalPluginId(value.parent.installation) ||
        !opaque(value.parent.generation))) ||
    !validConsent(value.consent) ||
    !Array.isArray(value.agents) ||
    value.agents.length > 256 ||
    !value.agents.every(
      (agent) =>
        object(agent) &&
        keys(agent, ['slug', 'previousProject']) &&
        typeof agent.slug === 'string' &&
        isCanonicalPluginId(agent.slug) &&
        (agent.previousProject === null ||
          (typeof agent.previousProject === 'string' &&
            agent.previousProject.length <= 256)),
    ) ||
    !Array.isArray(value.ownedDependencies) ||
    value.ownedDependencies.length > 256 ||
    !value.ownedDependencies.every(
      (entry) =>
        object(entry) &&
        keys(entry, ['id', 'contentDigest', 'generation']) &&
        typeof entry.id === 'string' &&
        isCanonicalPluginId(entry.id) &&
        typeof entry.contentDigest === 'string' &&
        DIGEST.test(entry.contentDigest) &&
        (entry.generation === undefined ||
          (typeof entry.generation === 'string' &&
            /^[0-9a-f-]{36}$/.test(entry.generation))),
    )
  )
    return false;
  if (
    value.previous !== null &&
    (!object(value.previous) ||
      !keys(value.previous, [
        'scope',
        'installation',
        'generation',
        'artifact',
        'materialization',
        'dataScope',
        'origin',
      ]) ||
      !opaque(value.previous.scope) ||
      typeof value.previous.installation !== 'string' ||
      !isCanonicalPluginId(value.previous.installation) ||
      !opaque(value.previous.generation) ||
      !opaque(value.previous.materialization) ||
      !opaque(value.previous.dataScope) ||
      typeof value.previous.origin !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.previous.origin) ||
      !object(value.previous.artifact) ||
      !keys(value.previous.artifact, ['digest']) ||
      typeof value.previous.artifact.digest !== 'string' ||
      !DIGEST.test(value.previous.artifact.digest))
  )
    return false;
  return Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024;
}

const permits = new WeakMap<
  object,
  {
    owner: object;
    current: () => boolean;
    plan: PluginActivationPlan;
    readPlan?: () => PluginActivationPlan | null;
    active: boolean;
    verified: boolean;
    completed: boolean;
  }
>();
/** Opaque installer capability: a JSON value cannot name or construct it. */
export interface PluginActivationPermit {
  readonly __pluginActivationPermit: unique symbol;
}
export function issuePluginActivationPermit(
  owner: object,
  current: () => boolean,
  plan: PluginActivationPlan,
  readPlan?: () => PluginActivationPlan | null,
): PluginActivationPermit {
  const permit = Object.freeze({}) as PluginActivationPermit;
  permits.set(permit, {
    owner,
    current,
    plan: structuredClone(plan),
    readPlan,
    active: true,
    verified: false,
    completed: false,
  });
  return permit;
}
export function activationPermitPlan(
  permit: PluginActivationPermit,
  owner: object,
): PluginActivationPlan {
  const state = permits.get(permit);
  if (!state || state.owner !== owner || !state.active || !state.current())
    throw new Error('Plugin activation ownership changed');
  const currentPlan = state.readPlan ? state.readPlan() : state.plan;
  if (!currentPlan) throw new Error('Plugin activation plan is unavailable');
  return structuredClone(currentPlan);
}
export async function verifyPluginActivation(
  permit: PluginActivationPermit,
  owner: object,
  verify: (plan: PluginActivationPlan) => Promise<void>,
): Promise<void> {
  const plan = activationPermitPlan(permit, owner);
  await verify(plan);
  if (
    JSON.stringify(activationPermitPlan(permit, owner)) !== JSON.stringify(plan)
  )
    throw new Error(
      'Plugin activation ownership plan changed during verification',
    );
  permits.get(permit)!.verified = true;
}
export function revokePluginActivationPermit(
  permit: PluginActivationPermit,
  owner: object,
): void {
  const state = permits.get(permit);
  if (state?.owner === owner) {
    state.active = false;
    state.completed = false;
  }
}

export function activationPermitExecutionCurrent(
  permit: PluginActivationPermit,
  owner: object,
): boolean {
  const state = permits.get(permit);
  return (
    !!state &&
    state.owner === owner &&
    (state.completed || (state.active && state.current()))
  );
}
export function markPluginActivationPermitCompleted(
  permit: PluginActivationPermit,
  owner: object,
): void {
  const state = permits.get(permit);
  if (state?.owner !== owner || state.active || !state.verified)
    throw new Error('Plugin activation receipt is unavailable');
  state.completed = true;
}

export function consumePluginActivationPermit(
  permit: PluginActivationPermit,
  owner: object,
): void {
  activationPermitPlan(permit, owner);
  const state = permits.get(permit)!;
  if (!state.verified)
    throw new Error('Plugin activation resources have not been verified');
  state.active = false;
}

export function pluginActivationDescriptorDigest(
  manifest: PluginManifest,
): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`;
}
