import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, ConfirmDialog } from '../components/ui';
import { PlanningTypeChooser } from '../components/shiftRecommendation/PlanningTypeChooser';
import { useTranslation } from '../contexts/LanguageContext';
import { PLANNING_TYPES, parsePlanningType, type PlanningType } from '../utils/shiftRecommendationScreens';
import MonthlyPlanPage from './MonthlyPlanPage';
import ShiftRecommendationPage from './ShiftRecommendationPage';
import SimulatedRidesPage from './SimulatedRidesPage';

/** The `art` value of the simulated-ride generator; deliberately not a PlanningType. */
const SIMULATED_ART = 'simuliert';
/** Set by the Fahrtenbuch's button, so the generator's back link returns there and not to the chooser. */
export const FROM_FAHRTENBUCH = 'fahrtenbuch';

/**
 * /monatsplan opens on a choice, and the choice lives in the address (`?art=`).
 *
 * In the address rather than in state so that a reload stays where it was and
 * the e2e specs, which are written against the standard plan, can open
 * `/monatsplan?art=standard` directly. `MonthlyPlanPage` is rendered untouched:
 * Type 1 is proved unchanged by that file having no diff at all.
 *
 * Leaving the standard plan asks first. Its plan lives in memory until it is
 * confirmed, and the link sits above all eight of its steps, so one click on
 * step 7 would otherwise throw a whole distribution away with no word. The
 * recommendation asks nothing: it is recomputed from the same months in a
 * moment, and a dialog there would only be friction.
 */
export default function MonthlyPlanEntryPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const type = parsePlanningType(params.get('art'));
  const [confirmLeave, setConfirmLeave] = useState(false);

  const choose = (next: PlanningType | null) => {
    const copy = new URLSearchParams(params);
    if (next) copy.set('art', next);
    else copy.delete('art');
    setParams(copy);
  };

  // Not a way to plan: a generator of marked, simulated rides whose output is a
  // Fahrtenbuch import. It is offered on the Fahrtenbuch page beside Import; this
  // address stays so that existing bookmarks and links keep opening it.
  if (params.get('art') === SIMULATED_ART) {
    return (
      <div className="font-ui">
        {params.get('from') === FROM_FAHRTENBUCH ? (
          <Button variant="link" className="mb-3" onClick={() => navigate('/fahrtenbuch')}>{t('simrides.back.fahrtenbuch')}</Button>
        ) : (
          <Button variant="link" className="mb-3" onClick={() => choose(null)}>{t('mplanType.switch')}</Button>
        )}
        <SimulatedRidesPage />
      </div>
    );
  }

  if (!type) {
    return (
      <PlanningTypeChooser onChoose={choose} />
    );
  }

  return (
    <div className="font-ui">
      <Button
        variant="link"
        className="mb-3"
        onClick={() => (type === PLANNING_TYPES.standard ? setConfirmLeave(true) : choose(null))}
      >
        {t('mplanType.switch')}
      </Button>
      {type === PLANNING_TYPES.standard ? <MonthlyPlanPage /> : <ShiftRecommendationPage />}
      <ConfirmDialog
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        onConfirm={() => choose(null)}
        title={t('mplanType.leaveTitle')}
        description={t('mplanType.leaveBody')}
        confirmLabel={t('mplanType.leaveConfirm')}
      />
    </div>
  );
}
