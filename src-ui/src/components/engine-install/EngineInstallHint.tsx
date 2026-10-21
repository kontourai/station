/**
 * How to install an engine Station did not find, on the computer Station runs
 * on. The recipe is the server's projection for the host's platform
 * (`hostInstall`); Station only shows it and never runs it. On a paired
 * device the command moves into `HostAction`'s guidance, which names the host.
 */

import type { ACPEngineInstallRecipe } from '@kontourai/station-contracts/acp';
import type { DevicePresentation } from '@kontourai/station-contracts/system-status';
import { useState } from 'react';
import { copyToClipboard } from '../../lib/clipboard';
import { openExternalLink } from '../../platform/openExternalLink';
import { Button } from '../Button';
import { HostAction } from '../host-action/HostAction';
import { hostActionCopy } from '../host-action/host-action-copy';
import './EngineInstallHint.css';

export function EngineInstallHint({
  name,
  recipe,
  devicePresentation,
  onCheckAgain,
  checking = false,
  provenance,
}: {
  name: string;
  /** The plugin that supplied this recipe; absent for Station's own catalogue. */
  provenance?: string;
  recipe: ACPEngineInstallRecipe | undefined;
  devicePresentation: DevicePresentation | undefined;
  /** Re-runs detection. Absent where the surface cannot re-detect on demand. */
  onCheckAgain?: () => void;
  checking?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const command = recipe?.command;
  return (
    <fieldset
      className="engine-install-hint"
      data-testid="engine-install-hint"
      aria-label={`How to install ${name}`}
    >
      <HostAction
        id="engine-install-command"
        presentation={devicePresentation}
        command={command}
      >
        {command ? (
          <div className="engine-install-hint__command-row">
            <span className="engine-install-hint__label">
              {hostActionCopy('engine-install-command', devicePresentation)}
            </span>
            <code className="engine-install-hint__command">{command}</code>
            <Button
              size="sm"
              className={copyFailed ? 'copy-affordance--failed' : undefined}
              aria-label={`Copy the ${name} install command`}
              onClick={() => {
                void copyToClipboard(command).then((ok) => {
                  setCopied(ok);
                  setCopyFailed(!ok);
                });
              }}
            >
              {copied ? 'Copied' : copyFailed ? "Can't copy" : 'Copy'}
            </Button>
          </div>
        ) : null}
      </HostAction>
      {provenance ? (
        <p className="engine-install-hint__note">Provided by {provenance}</p>
      ) : null}
      {recipe?.note ? (
        <p className="engine-install-hint__note">{recipe.note}</p>
      ) : null}
      <div className="engine-install-hint__actions">
        {recipe?.docsUrl ? (
          <a
            className="engine-install-hint__docs"
            href={recipe.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => {
              event.preventDefault();
              void openExternalLink(recipe.docsUrl as string);
            }}
          >
            {name} install guide
          </a>
        ) : null}
        {onCheckAgain ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={checking}
            aria-label={`Check again for ${name}`}
            onClick={onCheckAgain}
          >
            {checking ? 'Checking…' : 'Check again'}
          </Button>
        ) : null}
      </div>
    </fieldset>
  );
}
