import {
  type BuiltInToolCategory,
  type EngineCapabilityMatrix,
} from '@kontourai/station-contracts/engine-capability-matrix';
import './EngineCapabilitySummary.css';

/**
 * The two-row engine description (archive#3722): WHAT IT CAN DO as
 * chips derived from the engine's capability matrix, and WHAT STATION GATES
 * from the matrix's tool-policy cell. Every rendered word traces to a matrix
 * cell — the matrix is the single per-engine declaration the agent editor
 * and session delivery already read, so this surface cannot drift from them.
 *
 * What is deliberately NOT here: shell/filesystem chips. The matrix carries
 * no derivation for an external engine's own toolbox (a custom engine's
 * tools are whatever it brings), and a chip that is sometimes a guess is
 * worse than no chip — the tools row says exactly that instead. Widening the
 * matrix with audited runtime capabilities is archive#3722's remaining scope.
 */

/** The matrix cells that read as user-meaningful "Station can deliver X". */
const CAPABILITY_CHIPS: ReadonlyArray<{
  key:
    | 'systemPrompt'
    | 'toolServers'
    | 'skills'
    | 'commands'
    | 'modelSelection';
  label: string;
}> = [
// "System prompt", not "Prompt": the retired Prompts surface's noun is
// gate-banned as a standalone capital-P word (noun-consistency-gate), and
// the capability IS the system prompt, so the precise name is also the
// passing one.
  { key: 'systemPrompt', label: 'System prompt' },
  { key: 'toolServers', label: 'Tool servers' },
  { key: 'skills', label: 'Skills' },
  { key: 'commands', label: 'Commands' },
  { key: 'modelSelection', label: 'Model selection' },
];

export function deriveCapabilityChips(
  matrix: EngineCapabilityMatrix,
): string[] {
  const chips = CAPABILITY_CHIPS.filter(
    ({ key }) => matrix[key].state !== 'unsupported',
  ).map(({ label }) => label);
  if (matrix.midTurnSteer) chips.push('Mid-turn steering');
  return chips;
}

const TOOL_CATEGORY_LABELS: Record<BuiltInToolCategory, string> = {
  shell: 'shell commands',
  'file-read': 'file reading',
  'file-edit': 'file editing',
};

/**
 * The tools-ownership sentence, now derived from the audited `builtInTools`
 * cell (archive#3722) rather than an engineId branch:
 *
 * - `station-configured` — the Station engine has no toolbox of its own.
 * - `documented` — the cell's evidence-backed categories, named in user
*   words ("shell commands, file editing"). This is the answer to the
*   owner's original question ("does it have bash and file access?"), and
*   it renders only where a matrix cell cites a real observation seam.
 * - `unenumerated` — Station cannot list the toolbox; say so.
 *
 * The archive#3726 caught the pre-audit version contradicting the chip row
 * above it ("Station does not choose what <engine> can use" while the Tool
 * servers chip said Station delivers some); the supply clause still composes
 * with the toolServers cell so the two claims cannot diverge.
 */
export function deriveToolsOwnership(
  matrix: EngineCapabilityMatrix,
  connectionName: string,
): string {
  const cell = matrix.builtInTools;
  if (cell.state === 'station-configured') {
    return 'Runs the tools Station supplies to the agent.';
  }
  const base =
    cell.state === 'documented'
      ? `Runs its own built-in tools, including ${cell.categories
          .map((category) => TOOL_CATEGORY_LABELS[category])
          .join(', ')}.`
      : // Conditional on purpose (#3728 review): for an unenumerated engine
// Station cannot establish that any built-ins EXIST — only that it
// has no inventory of whatever the engine may provide.
        `Station cannot enumerate any built-in tools ${connectionName} may provide.`;
  return matrix.toolServers.state !== 'unsupported'
    ? `${base} Station can additionally supply the tool servers configured here.`
    : base;
}

/**
 * The tool-control sentence for the gating row, from the audited
 * `builtInToolControl` cell. The owner asked whether Station could "turn
 * off" an engine's own tools; this answers with what is actually wired —
 * and the audit found NO external engine has a wired per-tool disable
 * today, so the honest sentence for all of them is that none exists. A
 * control renders here only when a future cell names a real enforcement
 * path (the audit rule recorded on the cell type).
 */
export function deriveToolControlSummary(
  matrix: EngineCapabilityMatrix,
): string | null {
  switch (matrix.builtInToolControl.state) {
    case 'station-owned':
// Redundant with the ownership sentence for the Station engine — the
// tools ARE the configuration — so no second sentence.
      return null;
    case 'none':
// The absolute phrasing is earned only where built-ins are PROVEN to
// exist (a documented cell); an unenumerated engine gets conditional
// wording, or the control sentence would assert the very inventory
 // the tools row just said Station cannot establish (archive#3728).
      return matrix.builtInTools.state === 'documented'
        ? 'Its built-in tools cannot be switched off from Station.'
        : 'Station cannot switch off any built-in tools it may provide.';
  }
}

/**
 * The may-do row, verbatim from the tool-policy cell. `coverageLimit` is the
 * matrix's own display-safe boundary statement, carried through unedited —
 * paraphrasing an enforcement limit is how limits get overstated.
 */
export function deriveGatingSummary(matrix: EngineCapabilityMatrix): string {
  const policy = matrix.toolPolicy;
  switch (policy.state) {
    case 'native':
      return 'Station approves or blocks every tool call before it runs.';
    case 'partial': {
      const base = 'Tool calls can require your approval in the transcript.';
      return policy.coverageLimit ? `${base} ${policy.coverageLimit}` : base;
    }
    case 'unsupported':
      return "Station does not gate this engine's tool calls.";
  }
}

export function EngineCapabilitySummary({
  matrix,
  connectionName,
}: {
/**
* The resolved matrix for the engine being described. Callers resolve it
* (`resolveEngineCapabilityMatrix`, or a literal entry for a surface that
* is one engine class by construction) — the resolver's unknown-engine
* default is itself the honest floor, so there is no guessed-row case
* left for this component to defend against.
*/
  matrix: EngineCapabilityMatrix;
  connectionName: string;
}) {
  const chips = deriveCapabilityChips(matrix);
  return (
    <div className="engine-capability-summary">
      <div className="engine-capability-summary__row">
        <span className="engine-capability-summary__label">What it can do</span>
        <span className="engine-capability-summary__body">
          {chips.length > 0 && (
            <span className="engine-capability-summary__chips">
              {chips.map((chip) => (
                <span className="engine-capability-summary__chip" key={chip}>
                  {chip}
                </span>
              ))}
            </span>
          )}
          <span className="engine-capability-summary__tools">
            {deriveToolsOwnership(matrix, connectionName)}
          </span>
        </span>
      </div>
      <div className="engine-capability-summary__row">
        <span className="engine-capability-summary__label">
          What Station gates
        </span>
        <span className="engine-capability-summary__body">
          <span>{deriveGatingSummary(matrix)}</span>
          {deriveToolControlSummary(matrix) && (
            <span className="engine-capability-summary__tools">
              {deriveToolControlSummary(matrix)}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
