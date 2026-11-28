/**
 * The state behind the update button of the Fahrer and Fahrzeuge pages: whether
 * this caller may run the partner import in place, the run itself, and what it
 * reported.
 *
 * It lives in a hook and not in the button because the button sits in the page
 * header and its outcome under it, in two places the page composes.
 */
import { useCallback, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useSuperAdmin } from '../../contexts/SuperAdminContext';
import { useCompanyScope } from '../../hooks/useCompanyScope';
import { runImportLeg, type ImportScope, type LegOutcome } from '../../lib/partnerFleetImport';
import { PARTNER_IMPORT_DEPS } from './FleetImportCard';
import { usePartnerConnected } from './usePartnerConnected';

export interface FleetUpdate {
  scope: ImportScope;
  /** False: the page offers the link to the full import instead of a button. */
  inPlace: boolean;
  running: boolean;
  outcome: LegOutcome | null;
  run: () => Promise<void>;
}

export function useFleetUpdate(scope: ImportScope, onImported?: () => void): FleetUpdate {
  const { isAdmin } = useAuth();
  const { effectiveCompanyId } = useSuperAdmin();
  const { canEdit } = useCompanyScope();
  const connection = usePartnerConnected(effectiveCompanyId);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<LegOutcome | null>(null);

  // The database asks is_company_admin() and refuses a support session itself.
  const inPlace = isAdmin && canEdit(undefined, 'drivers') && connection === 'connected';

  const run = useCallback(async () => {
    setRunning(true);
    setOutcome(null);
    try {
      const result = await runImportLeg(scope, PARTNER_IMPORT_DEPS);
      setOutcome(result);
      if (result.status === 'done') onImported?.();
    } finally {
      setRunning(false);
    }
  }, [scope, onImported]);

  return { scope, inPlace, running, outcome, run };
}
