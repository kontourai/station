import { useState } from 'react';
import { PageCreateAction } from '../../components/PageCreateAction';
import { AddMachineModal } from './AddMachineModal';
import { ComputersSection } from './ComputersSection';
import { IntegrationStatusSection } from './IntegrationStatusSection';

/**
 * Today's Computers screen at its own address. It is not a Customize item:
 * devices and other Stations move to the Station page. Until that page
 * exists, the links that name this address (relay invites, a project's
 * relay sign-in) keep working; pairing and Stations are in the
 * header's Station menu.
 */
export function ComputersPage() {
  const [chooserOpen, setChooserOpen] = useState(false);
  return (
    <div className="pane-host">
      <PageCreateAction
        label="Add computer"
        onClick={() => setChooserOpen(true)}
      />
      <IntegrationStatusSection />
      <ComputersSection />
      <AddMachineModal
        isOpen={chooserOpen}
        onClose={() => setChooserOpen(false)}
      />
    </div>
  );
}
