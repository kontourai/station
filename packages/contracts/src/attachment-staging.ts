import type {
  ChatAttachmentKind,
  ChatAttachmentMimeType,
} from './chat-attachment.js';

/** The only staged-attachment protocol this client understands. */
export const ATTACHMENT_STAGING_PROTOCOL_VERSION = 1 as const;
/** A composer never starts more than this many uploads at once. */
export const ATTACHMENT_STAGING_MAX_CONCURRENT_UPLOADS = 3 as const;

/**
 * Capability negotiation stays deliberately three-valued. A malformed or
 * unknown peer is not permission to fall back to a large inline request.
 */
export type AttachmentStagingCapability =
  | {
      state: 'supported';
      version: typeof ATTACHMENT_STAGING_PROTOCOL_VERSION;
      /** Current-host delegation can materialize staged files in its workspace. */
      delegationFiles?: true;
      maxConcurrentUploads: typeof ATTACHMENT_STAGING_MAX_CONCURRENT_UPLOADS;
    }
  | { state: 'legacy' }
  | { state: 'unknown' };

/** Public metadata for a staged object. It never carries bytes, a path or a grant. */
export interface StagedAttachmentReference {
  stageId: string;
  /** Stable composer occurrence identity; never a filesystem path or blob key. */
  clientAttachmentId: string;
  /** Deliberately coarse: identifies the authority surface, never a local path. */
  source: 'current-composer';
  kind: ChatAttachmentKind;
  name: string;
  mimeType: ChatAttachmentMimeType;
  size: number;
  digest: `sha256-${string}`;
  expiresAt: string;
}

/** Short-lived upload authority. This is request-only and must never be persisted. */
export interface AttachmentStagingUploadGrant {
  stageId: string;
  uploadGrant: string;
  expiresAt: string;
}

export interface AttachmentStagingPreparation
  extends AttachmentStagingUploadGrant {
  clientAttachmentId: string;
  kind: ChatAttachmentKind;
  name: string;
  mimeType: ChatAttachmentMimeType;
  size: number;
}

/** Reconnect-safe status projection: no grant and no raw bytes. */
export type AttachmentStagingStatus =
  | { stageId: string; state: 'pending'; expiresAt: string }
  | { stageId: string; state: 'complete'; reference: StagedAttachmentReference }
  /** Accepted turns retain only an idempotency tombstone; bytes are released. */
  | { stageId: string; state: 'accepted'; expiresAt: string }
  | { stageId: string; state: 'expired' | 'missing' | 'cancelled' };

/** Closed, file-delivery refusals shared by the CLI and executing host. */
export type DelegationFileRefusalCode =
  | 'delegation_files_unsupported'
  | 'delegation_files_duplicate_name'
  | 'delegation_files_count'
  | 'delegation_files_size'
  | 'delegation_files_invalid_name'
  | 'delegation_files_invalid_data'
  | 'delegation_files_ref_invalid'
  | 'delegation_files_unavailable'
  | 'delegation_files_start_refused'
  | 'delegation_files_turn_refused'
  | 'delegation_files_outcome_unknown'
  | 'delegation_files_cleanup_failed';
