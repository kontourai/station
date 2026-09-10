/**
 * The caller-caused refusals the agent-workflow store can produce.
 *
 * These exist so a route can answer them with the status they deserve
 * without reading their message text. Every one used to be a bare
 * `new Error(...)`, which left a route with two bad options: label every
 * failure from the call with one hard-coded status (what
 * `routes/projects/layouts.ts` did — a disk error answered 400), or match on
 * the message (what `routes/operations/ssh-environments.ts` does, and the
 * defect this contract exists to remove).
 *
 * They stay HTTP-free on purpose: the domain says *what* was refused, and
 * `layouts.ts`'s `mapServiceError` decides the status. `code` is the stable
 * identity a route hands to the client, so the same refusal reads the same
 * from every caller and survives a rewording of the message.
 *
 * The messages are byte-identical to the plain `Error`s these replace, so
 * the two domain suites that assert on that text, and every route still
 * formatting the message itself, are unaffected.
 */

export class WorkflowInvalidError extends Error {
  readonly code = 'workflow_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'WorkflowInvalidError';
  }
}

export class WorkflowNotFoundError extends Error {
  readonly code = 'workflow_not_found';

  constructor(workflowId: string) {
    super(`Workflow '${workflowId}' not found`);
    this.name = 'WorkflowNotFoundError';
  }
}

export class WorkflowExistsError extends Error {
  readonly code = 'workflow_exists';

  constructor(workflowId: string) {
    super(`Workflow '${workflowId}' already exists`);
    this.name = 'WorkflowExistsError';
  }
}

/**
 * A workflow already on disk whose content fails the context-safety scan.
 *
 * Separate from {@link WorkflowInvalidError} because the request is not
 * malformed and re-sending it will not help: the stored file is. The route
 * answers 422 -- the request was understood and the stored entity cannot be
 * served -- and carries this message, which names the rule and the file, so
 * the user knows which of their own files to fix.
 *
 * Disclosure: the message quotes ±30 characters around the match, i.e. the
 * file's own bytes. That is the same sentence the write path already returns
 * at 400 when the same content is submitted, so a reader learns nothing here
 * they could not learn by writing the file again.
 */
export class WorkflowUnsafeContentError extends Error {
  readonly code = 'workflow_unsafe_content';

  constructor(message: string) {
    super(message);
    this.name = 'WorkflowUnsafeContentError';
  }
}
