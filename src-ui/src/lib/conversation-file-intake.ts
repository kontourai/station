import { CHAT_ATTACHMENT_MAX_COUNT } from '@kontourai/station-contracts/chat-attachment';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';

export type FileIntakeScope = ApiRequestScope & { isCurrent: () => boolean };
export interface FileIntakeResult {
  added: number;
  errors: string[];
}
export interface FileIntakeOperation {
  requestScope: FileIntakeScope;
  signal: AbortSignal;
  isCurrent?: () => boolean;
}
type Receiver = {
  apiBase: string;
  sessionId: string;
  receive: (
    files: File[],
    operation: FileIntakeOperation,
  ) => Promise<FileIntakeResult>;
};
type Pending = {
  scope: FileIntakeScope;
  sessionId: string;
  files: File[];
  controller: AbortController;
  claimed?: Receiver;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: FileIntakeResult) => void;
  reject: (error: Error) => void;
};

/** UI handoff deadline, not an upload deadline: staging owns uploads after intake. */
export const FILE_INTAKE_HANDOFF_MS = 30_000;
const receivers = new Set<Receiver>();
const pending = new Set<Pending>();
const busy = new Set<string>();
const key = (apiBase: string, sessionId: string) =>
  JSON.stringify([apiBase, sessionId]);

function settle(request: Pending, result?: FileIntakeResult, error?: Error) {
  if (!pending.delete(request)) return;
  clearTimeout(request.timer);
  if (request.claimed)
    busy.delete(key(request.scope.apiBase, request.sessionId));
  if (error) {
    request.controller.abort(error);
    request.reject(error);
  } else request.resolve(result!);
  drain();
}
function drain() {
  for (const request of [...pending]) {
    if (request.claimed) continue;
    if (!request.scope.isCurrent()) {
      settle(
        request,
        undefined,
        new Error('The original Station is no longer selected.'),
      );
      continue;
    }
    const address = key(request.scope.apiBase, request.sessionId);
    if (busy.has(address)) continue;
    const receiver = [...receivers].find(
      (value) =>
        value.apiBase === request.scope.apiBase &&
        value.sessionId === request.sessionId,
    );
    if (!receiver) continue;
    request.claimed = receiver;
    busy.add(address);
    void Promise.resolve()
      .then(() =>
        receiver.receive(request.files, {
          requestScope: request.scope,
          signal: request.controller.signal,
        }),
      )
      .then(
        (result) => {
          if (!request.scope.isCurrent())
            settle(
              request,
              undefined,
              new Error(
                'Station access changed before the files were attached.',
              ),
            );
          else if (!result.added)
            settle(
              request,
              undefined,
              new Error(
                result.errors[0] ?? 'No files could be attached to this chat.',
              ),
            );
          else settle(request, result);
        },
        (error) =>
          settle(
            request,
            undefined,
            error instanceof Error
              ? error
              : new Error('Files could not be attached.'),
          ),
      );
  }
}

/** Exactly one visible composer consumes a drop, even when several panes show it. */
export function registerConversationFileReceiver(
  receiver: Receiver,
): () => void {
  receivers.add(receiver);
  drain();
  return () => {
    receivers.delete(receiver);
    for (const request of [...pending])
      if (request.claimed === receiver)
        settle(
          request,
          undefined,
          new Error(
            'The target chat closed or changed before accepting the files.',
          ),
        );
  };
}
export function requestConversationFileIntake(
  scope: FileIntakeScope,
  sessionId: string,
  files: File[],
  activate: () => void,
): Promise<FileIntakeResult> {
  if (!scope.isCurrent())
    return Promise.reject(
      new Error('Reconnect to this Station before attaching files.'),
    );
  if (!sessionId || !files.length || files.length > CHAT_ATTACHMENT_MAX_COUNT)
    return Promise.reject(
      new Error(`Choose between one and ${CHAT_ATTACHMENT_MAX_COUNT} files.`),
    );
  if (pending.size >= 8)
    return Promise.reject(
      new Error('Finish the pending file drops before adding more.'),
    );
  return new Promise((resolve, reject) => {
    const request: Pending = {
      scope,
      sessionId,
      files: [...files],
      controller: new AbortController(),
      resolve,
      reject,
      timer: setTimeout(
        () =>
          settle(
            request,
            undefined,
            new Error(
              'The target chat did not become ready to accept files. Open it and try again.',
            ),
          ),
        FILE_INTAKE_HANDOFF_MS,
      ),
    };
    pending.add(request);
    try {
      activate();
      drain();
    } catch (error) {
      settle(
        request,
        undefined,
        error instanceof Error
          ? error
          : new Error('The target chat could not be opened.'),
      );
    }
  });
}
