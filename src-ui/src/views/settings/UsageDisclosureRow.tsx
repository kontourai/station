import { useState } from 'react';
import { PageRow } from '../../components/PageRow';
import {
  SHARING_LABELS,
  type SharingCounts,
  type SharingDisclosure,
  UsageSharingIncluded,
} from '../../components/UsageSharingChoices';
import { settingsRow } from './settings-catalog';

export function UsageDisclosureRow({
  counts,
  disclosure,
}: {
  counts?: SharingCounts;
  disclosure?: SharingDisclosure;
}) {
  const [open, setOpen] = useState(false);
  return (
    <PageRow
      {...settingsRow('usage-disclosure')}
      description="Review the fields this Station reports for each usage sharing choice."
    >
      <details
        className="usage-telemetry-disclosure__inventory"
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>View included fields</summary>
        {open && (
          <>
            {counts && (
              <UsageSharingIncluded
                counts={counts}
                heading={SHARING_LABELS.lite}
              />
            )}
            {disclosure && (
              <UsageSharingIncluded
                data={disclosure}
                heading="Detailed usage"
                confirmation="none"
              />
            )}
            {!counts && !disclosure && (
              <p role="status">
                This Station did not report the usage sharing fields.
              </p>
            )}
          </>
        )}
      </details>
    </PageRow>
  );
}
