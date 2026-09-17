import { randomUUID, timingSafeEqual } from 'node:crypto';
import { canonicalizeForDigest } from '@kontourai/station-contracts/fleet-routing-receipt';
import type {
  RevisionAttributionAuthority,
  RevisionAttributionBinding,
  RevisionCorrelation,
} from '../../domain/revision-bound-evidence.js';
import { revisionEvidenceLinkViewDigest } from '../../domain/revision-bound-evidence.js';
import type {
  WorkingStateActor,
  WorkingStateSnapshot,
} from '../../domain/shared-working-state.js';
import type { EnvironmentSecurityService } from '../ssh/environment-security-service.js';
import type { EventStore } from './event-store.js';
import { projectTaskRoomDocumentId } from './project-task-room-document-id.js';
import type { ProjectTaskRoomLinkAuthority } from './project-task-room-history.js';
import type { RevisionPublication } from './project-task-room-working-state.js';

const MAX_ACTIVE_FREEZE_GRANTS = 256;

interface FreezeGrant {
  readonly scope: WorkingStateSnapshot['scope'];
  readonly sharedRevision: string;
  readonly actor: WorkingStateActor;
  readonly correlation: RevisionCorrelation;
}

function canonical(value: unknown): string {
  return JSON.stringify(canonicalizeForDigest(value));
}

function sameScope(
  left: WorkingStateSnapshot['scope'],
  right: WorkingStateSnapshot['scope'],
): boolean {
  return (
    left.projectId === right.projectId &&
    left.taskId === right.taskId &&
    left.documentId === right.documentId
  );
}

/** Production composition of archive#3546 persistence, attribution, and room links. */
export class ProjectTaskRoomRevisionEvidenceBridge {
  readonly #active = new Map<string, FreezeGrant>();
  readonly #security: EnvironmentSecurityService;
  readonly #module: ReturnType<EventStore['createRevisionEvidenceModule']>;
  #available = false;
  #closed = false;

  constructor(input: {
    eventStore: EventStore;
    security: EnvironmentSecurityService;
  }) {
    this.#security = input.security;
    const authority: RevisionAttributionAuthority = {
      resolve: ({ scope, sharedRevision, requestId }) => {
        const grant = this.#active.get(requestId);
        return grant &&
          sameScope(grant.scope, scope) &&
          grant.sharedRevision === sharedRevision
          ? {
              outcome: 'resolved',
              actor: grant.actor,
              correlation: grant.correlation,
            }
          : { outcome: 'unavailable' };
      },
      attest: (binding) => ({
        outcome: 'attested',
        attestation: this.#attestation(binding),
      }),
      verify: ({ attestation, ...binding }) => ({
        outcome: this.#sameAttestation(attestation, this.#attestation(binding))
          ? 'verified'
          : 'unavailable',
      }),
    };
    this.#module = input.eventStore.createRevisionEvidenceModule({
      attribution: authority,
    });
    this.#available = !('state' in this.#module.exportPortable());
  }

  available(): boolean {
    if (this.#closed) return false;
    try {
      const portable = this.#module.exportPortable();
      this.#security.signRevisionEvidenceAuthorityBinding(
        'station.revision-evidence.health/v1',
      );
      this.#available = !('state' in portable);
    } catch {
      this.#available = false;
    }
    return this.#available;
  }

  recordPublication(
    input: RevisionPublication,
  ):
    | { readonly kind: 'recorded'; readonly revisionId: string }
    | { readonly kind: 'unavailable' } {
    if (!this.available() || this.#active.size >= MAX_ACTIVE_FREEZE_GRANTS)
      return { kind: 'unavailable' };
    const requestId = randomUUID();
    this.#active.set(requestId, {
      scope: input.snapshot.scope,
      sharedRevision: input.workingRevision,
      actor: {
        actorId: input.actorId,
        kind: input.actorKind,
        ...(input.actorLabel ? { displayLabel: input.actorLabel } : {}),
      },
      correlation: input.correlation,
    });
    try {
      const frozen = this.#module.freeze({
        snapshot: input.snapshot,
        parents: input.parentEvidenceRevision
          ? [input.parentEvidenceRevision as `revision-evidence-v1:${string}`]
          : [],
        requestId,
      });
      return frozen.outcome === 'committed' || frozen.outcome === 'duplicate'
        ? { kind: 'recorded', revisionId: frozen.revision.revisionId }
        : { kind: 'unavailable' };
    } finally {
      this.#active.delete(requestId);
    }
  }

  readonly links: ProjectTaskRoomLinkAuthority = {
    resolve: async ({ kind, reference, scope }) => {
      if (kind !== 'revision' || !this.available())
        return { kind: 'unavailable' };
      const resolution = this.#module.reader().resolve({
        scope: {
          projectId: scope.projectId,
          taskId: scope.taskId,
          documentId: projectTaskRoomDocumentId(scope),
        },
        revisionId: reference as `revision-evidence-v1:${string}`,
      });
      if (resolution.state !== 'AVAILABLE') return { kind: 'unavailable' };
      const digest = revisionEvidenceLinkViewDigest(resolution.revision);
      return {
        kind: 'resolved',
        link: {
          schemaVersion: 'station.project-task-room-resolved-link/v1',
          kind: 'revision',
          stableId: resolution.revision.revisionId,
          digest,
          authorityReceiptId:
            this.#security.signRevisionEvidenceAuthorityBinding(
              canonical({
                kind: 'station.project-task-room-revision-link/v1',
                scope,
                revisionId: resolution.revision.revisionId,
                digest,
              }),
            ),
        },
      };
    },
  };

  /** Revalidate a published receipt against both its immutable evidence and
   * the working revision it actually settled; never infer it from the head. */
  matchesCommittedRevision(input: {
    scope: WorkingStateSnapshot['scope'];
    workingRevision: string;
    evidenceRevision: string;
  }): boolean {
    if (!this.available()) return false;
    try {
      const revision = this.#module.revision(
        input.evidenceRevision as `revision-evidence-v1:${string}`,
      );
      return Boolean(
        revision &&
          !('state' in revision) &&
          sameScope(revision.scope, input.scope) &&
          revision.sharedRevision === input.workingRevision,
      );
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#available = false;
    this.#active.clear();
    this.#module.close();
  }

  #attestation(binding: RevisionAttributionBinding): string {
    return this.#security.signRevisionEvidenceAuthorityBinding(
      canonical({
        kind: 'station.revision-evidence-attribution/v1',
        binding,
      }),
    );
  }

  #sameAttestation(left: string, right: string): boolean {
    try {
      const actual = Buffer.from(left, 'base64url');
      const expected = Buffer.from(right, 'base64url');
      return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
      );
    } catch {
      return false;
    }
  }
}

export type ProjectTaskRoomRevisionEvidencePort = Pick<
  ProjectTaskRoomRevisionEvidenceBridge,
  'available' | 'recordPublication' | 'links' | 'close'
> &
  Partial<
    Pick<ProjectTaskRoomRevisionEvidenceBridge, 'matchesCommittedRevision'>
  >;
