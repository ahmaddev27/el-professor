/**
 * The way into the fleet import from the screens a new company opens first.
 *
 * Empty, it is a prompt: a company with no drivers has nothing to lose by
 * importing them. Otherwise it is a quiet link, because the import is for the
 * start and an established company rarely needs it.
 */
import { Link } from 'react-router-dom';
import { Download } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import { Alert, Button } from '../ui';

export const FLEET_IMPORT_PATH = '/datenimport';

export function FleetImportShortcut({ empty = false }: { empty?: boolean }) {
  const { t } = useTranslation();
  const action = (
    <Button asChild variant={empty ? 'primary' : 'ghost'} size="sm">
      <Link to={FLEET_IMPORT_PATH}>
        <Download aria-hidden />
        {t('import.shortcut.action')}
      </Link>
    </Button>
  );

  if (empty) {
    return (
      <Alert tone="brand" role="note" title={t('import.shortcut.emptyTitle')} action={action} className="mb-4">
        {t('import.shortcut.emptyBody')}
      </Alert>
    );
  }
  return <div className="mb-2 flex justify-end">{action}</div>;
}
