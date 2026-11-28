/**
 * The prompt a company with no drivers (or no drivers and no cars) sees: a
 * company with nothing yet has nothing to lose by importing, and the link
 * leads to the full import (drivers, vehicles, earnings).
 *
 * Until 27.11.2026 this component also ran the update in place on the Fahrer
 * and Fahrzeuge pages. That is the page header's button now
 * (`FleetUpdate.tsx`), so only the prompt is left.
 */
import { Link } from 'react-router-dom';
import { Download } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import { Alert, Button } from '../ui';

export const FLEET_IMPORT_PATH = '/datenimport';

export function FleetImportShortcut() {
  const { t } = useTranslation();
  return (
    <Alert
      tone="brand"
      role="note"
      title={t('import.shortcut.emptyTitle')}
      action={(
        <Button asChild variant="primary" size="sm">
          <Link to={FLEET_IMPORT_PATH}>
            <Download aria-hidden />
            {t('import.shortcut.action')}
          </Link>
        </Button>
      )}
      className="mb-4"
    >
      {t('import.shortcut.emptyBody')}
    </Alert>
  );
}
