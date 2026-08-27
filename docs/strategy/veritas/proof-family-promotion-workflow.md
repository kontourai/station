# Proof Family Promotion Workflow

This workflow keeps Veritas useful without turning every historical guardrail into a permanent blocker.

## Dispositions

- `required`: protects the current trust contract and can block.
- `candidate`: useful signal, not a default blocker.
- `advisory`: information for reviewers and agents.
- `move-to-test`: product behavior that should be covered by normal tests.
- `upstream-abstraction`: reusable shape that belongs in Veritas.
- `retire`: historical or migration-only shape.

## Promotion Criteria

A family can move toward `required` only when it has:

- an owner,
- recent catch evidence,
- low enough false-positive risk,
- a review trigger or expiry condition,
- a documented reason normal tests do not already cover the failure.

Acceptable catch evidence includes:

- a real regression caught by the family,
- a mutation that normal tests miss and the family catches,
- repeated agent output that reintroduces the same issue,
- a second repo needing the same reusable verification shape.

## Demotion Criteria

Demote or retire a family when:

- catch evidence remains `unknown`,
- the check only preserves helper names or historical file shape,
- normal unit/integration/e2e tests now catch the same failure,
- false positives are frequent,
- the review trigger has fired.

For `move-to-test` families, the first acceptable reduction is route-selection proof plus a behavioral test command. In work-agent, `runtime-contracts` follows this path: runtime/server changes select `npm run test:connected-agents`, and the family remains advisory while source-shape assertions are retired behind behavioral coverage.

## Operating Rule

Every Veritas iteration should ask:

1. What can block today?
2. What is only advisory?
3. What should move into product tests?
4. What should become an upstream Veritas abstraction?
5. What should be deleted?
