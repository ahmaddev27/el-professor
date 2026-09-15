import { useEffect, useMemo } from 'react';
import { Outlet } from 'react-router-dom';
import {
  Banknote,
  Bell,
  Blocks,
  Calculator,
  CalendarClock,
  CalendarDays,
  Car,
  CreditCard,
  FileText,
  Info,
  Languages,
  LayoutDashboard,
  Moon,
  Receipt,
  Settings,
  Shield,
  StickyNote,
  Sun,
  TrendingUp,
  UserCog,
  Users,
  Wallet,
  Wrench,
} from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LanguageContext';
import { AppShell, Badge, Button, Tooltip, type AppShellNavGroup } from '../components/ui';
import { DESIGN_PREVIEW_PATH } from './gate';
import { PREVIEW_COMPANY, PREVIEW_PLAN, PREVIEW_USER } from './sampleData';

const to = (segment: string) => `${DESIGN_PREVIEW_PATH}/${segment}`;

export default function PreviewLayout() {
  const { t, language, setLanguage } = useTranslation();
  const { isDark, toggleTheme } = useTheme();

  useEffect(() => {
    const previous = document.title;
    document.title = `${t('preview.nav.section')} | El-Professor`;
    return () => {
      document.title = previous;
    };
  }, [t]);

  // The company navigation of Sidebar.tsx, same items and labels, grouped.
  // Only Übersicht, Fahrzeuge and Komponenten are part of the prototype; the
  // others open a placeholder.
  const navGroups = useMemo<AppShellNavGroup[]>(
    () => [
      {
        id: 'start',
        items: [{ id: 'overview', label: t('nav.overview'), to: DESIGN_PREVIEW_PATH, icon: LayoutDashboard, end: true }],
      },
      {
        id: 'operations',
        label: t('nav.section.operations'),
        items: [
          { id: 'fahrer', label: t('nav.fahrer'), to: to('fahrer'), icon: Users },
          { id: 'cars', label: t('nav.cars'), to: to('fahrzeuge'), icon: Car },
          { id: 'werkstatt', label: t('nav.werkstatt'), to: to('werkstatt'), icon: Wrench },
          { id: 'notes', label: t('nav.notes'), to: to('notizen'), icon: StickyNote },
          { id: 'notifications', label: t('nav.notifications'), to: to('benachrichtigungen'), icon: Bell },
        ],
      },
      {
        id: 'finance',
        label: t('nav.section.finance'),
        items: [
          { id: 'belege', label: t('nav.belege'), to: to('belege'), icon: Receipt },
          { id: 'umsaetze', label: t('nav.umsaetze'), to: to('umsaetze'), icon: TrendingUp },
          { id: 'fixkosten', label: t('nav.fixkosten'), to: to('fixkosten'), icon: CalendarClock },
          { id: 'bargeld', label: t('nav.bargeldbestand'), to: to('bargeldbestand'), icon: Banknote },
          { id: 'abrechnung', label: t('nav.abrechnung'), to: to('abrechnung'), icon: Calculator },
          { id: 'salaries', label: t('nav.salaries'), to: to('gehaelter'), icon: Wallet },
        ],
      },
      {
        id: 'planning',
        label: t('nav.section.planning'),
        items: [
          { id: 'planner', label: t('nav.planner'), to: to('monatsplanung'), icon: CalendarDays },
          { id: 'documents', label: t('nav.documents'), to: to('dokumente'), icon: FileText },
        ],
      },
      {
        id: 'management',
        label: t('nav.section.management'),
        items: [
          { id: 'users', label: t('nav.users'), to: to('benutzer'), icon: UserCog },
          { id: 'roles', label: t('nav.roles'), to: to('rollen'), icon: Shield },
          { id: 'billing', label: t('nav.billing'), to: to('abonnement'), icon: CreditCard },
          { id: 'settings', label: t('nav.settings'), to: to('einstellungen'), icon: Settings },
        ],
      },
      {
        id: 'preview',
        label: t('preview.nav.section'),
        items: [{ id: 'components', label: t('preview.nav.components'), to: to('komponenten'), icon: Blocks }],
      },
    ],
    [t],
  );

  const themeLabel = isDark ? t('shell.themeToLight') : t('shell.themeToDark');
  const nextLanguage = language === 'de' ? 'en' : 'de';

  return (
    <div data-design-preview="">
      <AppShell
        navGroups={navGroups}
        homeTo={DESIGN_PREVIEW_PATH}
        topBarStart={
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold text-fg">{PREVIEW_COMPANY}</span>
            <Badge tone="brand" className="hidden sm:inline-flex">
              {PREVIEW_PLAN}
            </Badge>
          </div>
        }
        topBarEnd={
          <>
            <Tooltip content={t('shell.language')}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLanguage(nextLanguage)}
                aria-label={`${t('shell.language')}: ${language.toUpperCase()}`}
                className="px-2.5"
              >
                <Languages aria-hidden />
                {language.toUpperCase()}
              </Button>
            </Tooltip>
            <Tooltip content={themeLabel}>
              <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label={themeLabel}>
                {isDark ? <Sun aria-hidden /> : <Moon aria-hidden />}
              </Button>
            </Tooltip>
            <div className="ml-1 flex items-center gap-2.5">
              <span
                aria-hidden
                className="flex size-8 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand-text"
              >
                {PREVIEW_USER.initials}
              </span>
              <span className="hidden leading-tight md:block">
                <span className="block text-sm font-semibold text-fg">{PREVIEW_USER.name}</span>
                <span className="block text-xs text-fg-subtle">{t('preview.user.role')}</span>
              </span>
            </div>
          </>
        }
        notice={
          <div role="note" className="flex items-start gap-2 border-b border-line bg-brand-soft px-4 py-2 text-[13px] text-brand-text sm:px-6">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
            <p>{t('preview.notice')}</p>
          </div>
        }
      >
        <Outlet />
      </AppShell>
    </div>
  );
}
