import { ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX, type LucideIcon } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { Badge } from '../components/ui';
import type { TuevInfo, TuevState } from './sampleData';

type Tone = 'positive' | 'caution' | 'critical' | 'neutral';

export const TUEV_PRESENTATION: Record<TuevState, { tone: Tone; icon: LucideIcon; labelKey: TranslationKey }> = {
  valid: { tone: 'positive', icon: ShieldCheck, labelKey: 'fleet.tuevStatus.valid' },
  expiringSoon: { tone: 'caution', icon: ShieldAlert, labelKey: 'fleet.tuevStatus.expiringSoon' },
  expired: { tone: 'critical', icon: ShieldX, labelKey: 'fleet.tuevStatus.expired' },
  unknown: { tone: 'neutral', icon: ShieldQuestion, labelKey: 'fleet.tuevStatus.unknown' },
};

export const TONE_TEXT_CLASS: Record<Tone, string> = {
  positive: 'text-positive',
  caution: 'text-caution',
  critical: 'text-critical',
  neutral: 'text-fg-subtle',
};

/** The status as words and an icon, with the day count beside it when it matters. */
export function TuevStatus({ info }: { info: TuevInfo }) {
  const { t } = useTranslation();
  const { tone, icon: Icon, labelKey } = TUEV_PRESENTATION[info.state];
  const showDays = info.daysLeft !== null && info.state !== 'valid';
  const days = info.daysLeft ?? 0;

  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Badge tone={tone}>
        <Icon aria-hidden />
        {t(labelKey)}
      </Badge>
      {showDays ? (
        <span className="whitespace-nowrap text-[13px] tabular-nums text-fg-subtle">
          {days < 0 ? t('preview.cars.daysOverdue', { days: Math.abs(days) }) : t('preview.cars.daysLeft', { days })}
        </span>
      ) : null}
    </span>
  );
}
