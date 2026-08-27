import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type {
  ContributionRead,
  ContributionReadV2,
} from '@kontourai/surface/basis';
import type { ExactAnswerAssessmentRead } from '../evidence/answer-assessment-module.js';
import type {
  SessionAnswerBasisQueryOutcome,
  SessionQueryModule,
} from '../orchestration/session-query-module.js';
import { createTaskBasisQueryModule } from './task-basis-module.js';
import type { TaskGraphService } from './task-graph-service.js';
import { TaskOutputModule } from './task-output-module.js';
import type { TaskGateEvaluationReferenceRead } from './task-tool-result-reference-read-adapter.js';
import { createTaskToolResultReferenceReadAdapter } from './task-tool-result-reference-read-adapter.js';

/**
 * The one production seam for the read-only Task Basis owners. Keeping the
 * output owner and query module together makes the runtime route and its
 * composed-owner proof use the same authority graph.
 */
export function createTaskBasisRuntimeComposition(input: {
  homeDir: string;
  taskGraphService: TaskGraphService;
  sessionQueries: SessionQueryModule;
  hosted?: () => boolean;
  canReadSession: (
    sessionId: string,
    authority: SessionReadAuthority,
  ) => boolean;
  readAssessment?: (input: {
    answer: Extract<SessionAnswerBasisQueryOutcome, { status: 'found' }>;
    authority: SessionReadAuthority;
    taskId: string;
    answerReferenceId: string;
  }) => Promise<ExactAnswerAssessmentRead>;
  readReviewedSource?: (input: {
    answer: Extract<SessionAnswerBasisQueryOutcome, { status: 'found' }>;
    assessment: ExactAnswerAssessmentRead | undefined;
    authority: SessionReadAuthority;
    taskId: string;
    answerReferenceId: string;
  }) => Promise<ContributionReadV2 | undefined>;
  readNarrative?: (input: {
    answer: Extract<SessionAnswerBasisQueryOutcome, { status: 'found' }>;
    authority: SessionReadAuthority;
    taskId: string;
    answerReferenceId: string;
    associationRevision?: number;
    request?: Request;
  }) => Promise<ContributionRead>;
  gateEvaluationReferences?: TaskGateEvaluationReferenceRead;
}) {
  const taskOutputs = new TaskOutputModule({
    homeDir: input.homeDir,
    taskGraphService: input.taskGraphService,
    ...(input.hosted ? { hosted: input.hosted } : {}),
  });
  const taskToolResultReferences = createTaskToolResultReferenceReadAdapter({
    taskGraph: input.taskGraphService,
    sessionQueries: input.sessionQueries,
    canReadSession: input.canReadSession,
  });
  const taskBasis = createTaskBasisQueryModule({
    taskGraph: input.taskGraphService,
    sessionQueries: input.sessionQueries,
    outputs: taskOutputs,
    toolResultReferences: taskToolResultReferences,
    gateEvaluationReferences: input.gateEvaluationReferences,
    readAssessment: input.readAssessment,
    readReviewedSource: input.readReviewedSource,
    readNarrative: input.readNarrative,
  });
  return { taskOutputs, taskBasis, taskToolResultReferences };
}
