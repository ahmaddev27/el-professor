import { FlaskConical } from 'lucide-react';
import { Alert, Badge } from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';

/**
 * The marker of a simulated ride on screen. Words and an icon, never colour
 * alone. It takes no prop that hides it: see utils/simulatedRides/marker.ts.
 */
export function SimulatedBadge() {
  const { t } = useTranslation();
  return (
    <Badge tone="caution" title={t('simrides.badge.title')}>
      <FlaskConical aria-hidden />
      {t('simrides.badge')}
    </Badge>
  );
}

/** Shown above a list that contains at least one simulated ride. */
export function SimulatedNotice() {
  const { t } = useTranslation();
  return (
    <Alert tone="caution" title={t('simrides.notice.title')} icon={FlaskConical} role="note">
      {t('simrides.notice.body')}
    </Alert>
  );
}
