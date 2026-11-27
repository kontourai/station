import { useState } from 'react';
import { ActionRow } from '../components/ActionRow';
import { Button } from '../components/Button';
import { IconButton } from '../components/IconButton';
import { RefreshGlyph } from '../components/icons/Glyph';
import { ProvenanceBadge } from '../components/ProvenanceBadge';
import { Toggle } from '../components/Toggle';

export function ActionRowStory() {
  const [notice, setNotice] = useState('');
  return (
    <>
      <ActionRow
        label="Release note actions"
        overflowLabel="More release note actions"
        primary={
          <Button onClick={() => setNotice('Release note saved')}>Save</Button>
        }
        secondary={
          <Button
            variant="secondary"
            onClick={() => setNotice('Release note preview opened')}
          >
            Preview
          </Button>
        }
        overflow={[
          {
            key: 'duplicate',
            label: 'Duplicate',
            onSelect: () => setNotice('Release note duplicated'),
          },
          {
            key: 'archive',
            label: 'Archive',
            onSelect: () => setNotice('Release note archived'),
          },
        ]}
      />
      <p role="status">{notice}</p>
    </>
  );
}

export function SettingsControlStory() {
  const [notifications, setNotifications] = useState(false);
  const [notice, setNotice] = useState('');
  return (
    <>
      <div>
        <label htmlFor="catalog-notifications">Desktop notifications</label>
        <Toggle
          id="catalog-notifications"
          label="Desktop notifications"
          checked={notifications}
          onChange={setNotifications}
          showStateLabel
        />
      </div>
      <div>
        <label htmlFor="catalog-managed-reviews">Managed reviews</label>
        <Toggle
          id="catalog-managed-reviews"
          label="Managed reviews"
          checked
          onChange={() => {}}
          disabled
          showStateLabel
        />
      </div>
      <p>
        Provider endpoint <ProvenanceBadge provenance={{ source: 'env' }} />
      </p>
      <IconButton
        aria-label="Refresh settings"
        onClick={() => setNotice('Settings refreshed')}
      >
        <RefreshGlyph />
      </IconButton>
      <p role="status">{notice}</p>
    </>
  );
}
