/** Public, metadata-only Session Outputs transport (v1). */
export const SESSION_OUTPUTS_V1 = 'session-outputs/v1' as const;

export type SessionOutputRef = { sessionId: string; eventId: string };

export type SessionOutputItem = {
  ref: SessionOutputRef;
  turnId: string;
  toolCallId: string;
  declaredAt: string;
  label?: string;
  descriptor:
    | {
        kind: 'workspace-file';
        relativePath: string;
        mediaType?: string;
        digest: string;
        length: number;
      }
    | {
        kind: 'pull-request';
        provider: string;
        host: string;
        repository: { owner: string; name: string };
        ref: string;
        nativeId: string;
        /** This identity names live external state; it is never a snapshot. */
        liveExternal: true;
      };
};

export type SessionOutputsPage = {
  version: typeof SESSION_OUTPUTS_V1;
  items: readonly SessionOutputItem[];
  /** Opaque cursor, valid only for this exact Session and high-water mark. */
  cursor?: string;
  /** A corrupted durable descriptor was withheld; no phantom item/count exists. */
  partial: boolean;
};

export type SessionOutputInspection =
  | {
      version: typeof SESSION_OUTPUTS_V1;
      item: SessionOutputItem;
      kind: 'metadata';
    }
  | {
      version: typeof SESSION_OUTPUTS_V1;
      item: SessionOutputItem;
      kind: 'text';
      text: string;
    }
  | {
      version: typeof SESSION_OUTPUTS_V1;
      item: SessionOutputItem;
      kind: 'image';
      mediaType: 'image/png' | 'image/jpeg';
      data: string;
      width: number;
      height: number;
    };
