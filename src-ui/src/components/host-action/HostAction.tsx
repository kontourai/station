/**
 * HostAction — the ONE presentation rule for an affordance that executes on
 * the host's machine (station#3843 §2).
 *
 * Three branches, and no surface gets to invent a fourth:
 *
 *  1. `host` — the browser is on the machine Station runs on. The affordance
 *     renders exactly as it always did. Nothing is added, because there is no
 *     second machine to name.
 *  2. `paired` + `remote-safe` — the host performs it and the device only
 *     asks. The affordance still renders unchanged; the host's name is stated
 *     beside it so the person knows whose machine answered.
 *  3. `paired` + `host-hands` — it needs a shell run there, a file placed
 *     there, a binary installed there. The affordance is replaced by the
 *     instruction: the sentence naming the host, the exact command where
 *     there is one, and a Copy control. Never a disabled button (a disabled
 *     control is skipped in the tab order and explains nothing), never
 *     silently hidden (an absent affordance is indistinguishable from one
 *     Station never had).
 *
 * `presentation === undefined` — the status query has not answered yet, or
 * the route host is too old to serve the projection — takes branch 1. That
 * is the branch that makes NO claim about a second machine, which is the
 * only honest thing to render when nobody has computed the device class.
 *
 * WHAT DOES NOT LIVE HERE. Copy: it comes from `host-action-copy.ts`, and
 * `reach` is read from that same entry rather than passed in, so a surface
 * cannot re-classify an affordance at the call site. And a row whose
 * contract forbids added chrome — the Agents list's ONE fixing verb
 * (`tests/agents-readiness-board.spec.ts`) — consumes `hostActionCopy`
 * directly for its accessible name instead of mounting this wrapper. That is
 * still one map; it is not a second rule.
 */

import type { DevicePresentation } from '@kontourai/station-contracts/system-status';
import { type ReactNode, useState } from 'react';
import { copyToClipboard } from '../../lib/clipboard';
import { Button } from '../Button';
import {
  HOST_ACTION_COPY,
  type HostActionId,
  hostActionCopy,
} from './host-action-copy';
import './HostAction.css';

export interface HostActionProps {
  id: HostActionId;
  presentation: DevicePresentation | undefined;
  /**
   * The exact text a person has to run on the host. Rendered — and made
   * copyable — only on branch 3. An affordance whose repair is "go and do
   * something over there" with no single command (installing a CLI) supplies
   * none, and the guidance is then the sentence alone.
   */
  command?: string;
  /** The affordance itself. Branches 1 and 2 render it untouched. */
  children?: ReactNode;
  className?: string;
}

export function HostAction({
  id,
  presentation,
  command,
  children,
  className,
}: HostActionProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const paired = presentation?.deviceClass === 'paired';
  const copy = hostActionCopy(id, presentation);

  if (!paired) return <>{children}</>;

  if (HOST_ACTION_COPY[id].reach === 'remote-safe') {
    return (
      <div className={className ? `host-action ${className}` : 'host-action'}>
        {/* BEFORE the affordance, not after. Caught by eye in this lane's own
            paired capture: under a 100-row log list the sentence sat below the
            fold, so the one thing the page had to say about why the read looks
            thin was the one thing nobody would read. A helper that explains
            what an affordance is — and is not — has to be met on the way in.
            An empty host branch means the host has nothing extra to read; the
            paired branch always says which machine answered. */}
        {copy ? <p className="host-action__helper">{copy}</p> : null}
        {children}
      </div>
    );
  }

  return (
    <div
      className={
        className
          ? `host-action host-action--guidance ${className}`
          : 'host-action host-action--guidance'
      }
      data-host-action={id}
    >
      <p className="host-action__instruction">{copy}</p>
      {command ? (
        <>
          <code className="host-action__command">{command}</code>
          <Button
            size="sm"
            className={copyFailed ? 'copy-affordance--failed' : undefined}
            title={
              copyFailed
                ? 'This browser refused clipboard access — select the command above to copy it manually.'
                : undefined
            }
            onClick={() => {
              void copyToClipboard(command).then((ok) => {
                setCopied(ok);
                setCopyFailed(!ok);
              });
            }}
          >
            {copied ? 'Copied' : copyFailed ? "Can't copy" : 'Copy command'}
          </Button>
        </>
      ) : null}
    </div>
  );
}
