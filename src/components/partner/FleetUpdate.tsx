/**
 * The two halves of "update from Reidey" a page draws: the button for the page
 * header and the outcome under it. The state is `useFleetUpdate`'s.
 *
 * A caller who cannot run the import in place keeps the quiet link to the full
 * import page, so the header never offers a button the database would refuse.
 */
import { Link } from 'react-router-dom';
import { Download, RefreshCw } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import { updateFigures } from '../../lib/fleetUpdateSummary';
import { Alert, Button } from '../ui';
import { FLEET_IMPORT_PATH } from './FleetImportShortcut';
import { LEG_TITLE, LegOutcomeView, SkippedList } from './FleetImportCard';
import type { FleetUpdate } from './useFleetUpdate';

const UPDATE_LABEL = {
  drivers: 'import.shortcut.updateDrivers',
  vehicles: 'import.shortcut.updateVehicles',
} as const;

export function FleetUpdateButton({ update }: { update: FleetUpdate }) {
  const { t } = useTranslation();
  if (!update.inPlace) {
    return (
      <Button asChild variant="ghost">
        <Link to={FLEET_IMPORT_PATH}>
          <Download aria-hidden />
          {t('import.shortcut.action')}
        </Link>
      </Button>
    );
  }
  return (
    <Button variant="secondary" onClick={() => void update.run()} loading={update.running} disabled={update.running}>
      <RefreshCw aria-hidden />
      {t(UPDATE_LABEL[update.scope])}
    </Button>
  );
}

export function FleetUpdateOutcome({ update }: { update: FleetUpdate }) {
  const { t } = useTranslation();
  const { outcome } = update;
  if (!outcome) return null;
  if (outcome.status !== 'done') return <LegOutcomeView outcome={outcome} />;
  const figures = updateFigures(outcome.scope, outcome);
  return (
    <div className="space-y-3">
      <Alert tone="positive" title={t(LEG_TITLE[outcome.scope])}>
        <ul className="flex flex-wrap gap-x-5 gap-y-1">
          {figures.map(figure => (
            <li key={figure.key}>
              <span className="text-fg-muted">{t(figure.key)} </span>
              <span className="font-semibold tabular-nums">{figure.count}</span>
            </li>
          ))}
        </ul>
        {outcome.pull.truncated ? <p className="mt-2">{t('partner.pull.truncated')}</p> : null}
      </Alert>
      {outcome.scope === 'vehicles' ? <SkippedList scope="vehicles" skipped={outcome.result.skipped} /> : null}
    </div>
  );
}
