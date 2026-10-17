import type { ReactNode } from 'react';
import { BarChart3, CalendarDays, CheckCircle2, Clock, FileText, Users, Wallet, type LucideIcon } from 'lucide-react';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, PageHeader, cn } from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import type { TranslationKey } from '../../i18n';
import { PLANNING_TYPES, type PlanningType } from '../../utils/shiftRecommendationScreens';

/**
 * The pre-step of /monatsplan: two ways to plan a month.
 *
 * Type 1 is the standard plan exactly as it was; Type 2 is the shift
 * recommendation. Neither is the "default": a company that has always planned
 * with Type 1 must not read it as deprecated, so both cards carry the same
 * structure and only Type 2's border is tinted, to mark it as the newer choice.
 */
interface TypeCard {
  type: PlanningType;
  badge: TranslationKey;
  title: TranslationKey;
  description: TranslationKey;
  cta: TranslationKey;
  benefits: { icon: LucideIcon; text: TranslationKey }[];
  highlighted: boolean;
}

const CARDS: readonly TypeCard[] = [
  {
    type: PLANNING_TYPES.standard,
    badge: 'mplanType.type1.badge',
    title: 'mplanType.type1.title',
    description: 'mplanType.type1.description',
    cta: 'mplanType.type1.cta',
    highlighted: false,
    benefits: [
      { icon: CheckCircle2, text: 'mplanType.type1.b1' },
      { icon: Users, text: 'mplanType.type1.b2' },
      { icon: FileText, text: 'mplanType.type1.b3' },
    ],
  },
  {
    type: PLANNING_TYPES.shifts,
    badge: 'mplanType.type2.badge',
    title: 'mplanType.type2.title',
    description: 'mplanType.type2.description',
    cta: 'mplanType.type2.cta',
    highlighted: true,
    benefits: [
      { icon: BarChart3, text: 'mplanType.type2.b1' },
      { icon: Clock, text: 'mplanType.type2.b2' },
      { icon: Wallet, text: 'mplanType.type2.b3' },
      { icon: CalendarDays, text: 'mplanType.type2.b4' },
    ],
  },
];

export function PlanningTypeChooser({ onChoose }: { onChoose: (type: PlanningType) => void }): ReactNode {
  const { t } = useTranslation();
  return (
    <div className="font-ui">
      <PageHeader title={t('mplanType.title')} description={t('mplanType.subtitle')} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {CARDS.map(card => (
          <Card key={card.type} className={cn('flex flex-col', card.highlighted && 'border-brand/40')}>
            <CardHeader>
              <div className="min-w-0">
                <Badge tone={card.highlighted ? 'brand' : 'neutral'}>{t(card.badge)}</Badge>
                <CardTitle className="mt-2">{t(card.title)}</CardTitle>
                <CardDescription className="text-sm text-fg-muted">{t(card.description)}</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col justify-between gap-5">
              <ul className="grid grid-cols-1 gap-2">
                {card.benefits.map(({ icon: Icon, text }) => (
                  <li key={text} className="flex items-start gap-2 text-sm text-fg">
                    <Icon className="mt-0.5 size-4 shrink-0 text-brand-text" aria-hidden="true" />
                    <span>{t(text)}</span>
                  </li>
                ))}
              </ul>
              <Button className="w-full sm:w-auto sm:self-start" onClick={() => onChoose(card.type)}>
                {t(card.cta)}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
