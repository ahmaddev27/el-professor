/**
 * The way into the fleet import from the screens a new company opens first.
 *
 * Empty, it is a prompt: a company with no drivers has nothing to lose by
 * importing them, and the link leads to the full import (drivers, vehicles,
 * earnings). Otherwise, on a page that names its `scope`, it updates that page's
 * data alone, in place, when the company is connected and the caller may import;
 * anything less keeps the quiet link, so the page never offers a button the
 * database would refuse.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { useSuperAdmin } from '../../contexts/SuperAdminContext';
import { useCompanyScope } from '../../hooks/useCompanyScope';
import { runImportLeg, type ImportScope, type LegOutcome } from '../../lib/partnerFleetImport';
import { Alert, Button } from '../ui';
import { LegOutcomeView, PARTNER_IMPORT_DEPS } from './FleetImportCard';
import { usePartnerConnected } from './usePartnerConnected';

export const FLEET_IMPORT_PATH = '/datenimport';

const UPDATE_LABEL = {
  drivers: 'import.shortcut.updateDrivers',
  vehicles: 'import.shortcut.updateVehicles',
} as const;

interface FleetImportShortcutProps {
  empty?: boolean;
  /** The one leg this page imports. Without it the shortcut is only a link. */
  scope?: ImportScope;
  /** Called after the leg imported, so the page reloads its list. */
  onImported?: () => void;
}

export function FleetImportShortcut({ empty = false, scope, onImported }: FleetImportShortcutProps) {
  const { t } = useTranslation();
  const { isAdmin } = useAuth();
  const { effectiveCompanyId } = useSuperAdmin();
  const { canEdit } = useCompanyScope();
  const connection = usePartnerConnected(scope && !empty ? effectiveCompanyId : null);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<LegOutcome | null>(null);

  // The database asks is_company_admin() and refuses a support session itself.
  const inPlace = !empty && !!scope && isAdmin && canEdit(undefined, 'drivers') && connection === 'connected';

  const link = (
    <Button asChild variant={empty ? 'primary' : 'ghost'} size="sm">
      <Link to={FLEET_IMPORT_PATH}>
        <Download aria-hidden />
        {t('import.shortcut.action')}
      </Link>
    </Button>
  );

  if (empty) {
    return (
      <Alert tone="brand" role="note" title={t('import.shortcut.emptyTitle')} action={link} className="mb-4">
        {t('import.shortcut.emptyBody')}
      </Alert>
    );
  }
  if (!inPlace || !scope) return <div className="mb-2 flex justify-end">{link}</div>;

  const run = async () => {
    setRunning(true);
    setOutcome(null);
    const result = await runImportLeg(scope, PARTNER_IMPORT_DEPS);
    setOutcome(result);
    setRunning(false);
    if (result.status === 'done') onImported?.();
  };

  return (
    <div className="mb-2 space-y-3">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => void run()} loading={running} disabled={running}>
          <Download aria-hidden />
          {t(UPDATE_LABEL[scope])}
        </Button>
      </div>
      {outcome ? <LegOutcomeView outcome={outcome} /> : null}
    </div>
  );
}
