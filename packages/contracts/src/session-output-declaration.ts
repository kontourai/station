/**
 * Versioned, durable provenance for one result that a native Station tool
 * explicitly declared during a completed turn.  This is a candidate only:
 * it neither copies a file nor creates a Task reference.
 */
export const DECLARED_SESSION_OUTPUT_V1 = 'declared-output/v1' as const;

export type DeclaredSessionOutput = {
  version: typeof DECLARED_SESSION_OUTPUT_V1;
  kind: 'declared-output';
  sessionId: string;
  eventId: string;
};

export type DeclaredOutputDescriptor =
  | {
      kind: 'workspace-file';
      relativePath: string;
      digest: string;
      length: number;
      /** Advisory only; no preview or body is implied by this value. */
      mediaType?: string;
    }
  | {
      kind: 'pull-request';
      provider: string;
      host: string;
      repository: { owner: string; name: string };
      ref: string;
      nativeId: string;
    };

/** Stored DTO. Keep it small: never store file bytes or a PR body/digest. */
export interface DeclaredSessionOutputRecord {
  version: typeof DECLARED_SESSION_OUTPUT_V1;
  declarationId: string;
  sessionId: string;
  eventId: string;
  turnId: string;
  toolCallId: string;
  declaredAt: string;
  label?: string;
  descriptor: DeclaredOutputDescriptor;
}
