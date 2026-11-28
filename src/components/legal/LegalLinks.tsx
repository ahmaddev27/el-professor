import { Info, ShieldCheck } from 'lucide-react';
import { useTranslation } from '../../contexts/LanguageContext';
import { LEGAL_PATHS } from '../../lib/legalPages';
import { cn } from '../ui/cn';
import { RailTip } from '../ui/sidebarRail';

interface LegalLinksProps {
  /**
   * `onDark` for the sign-in and signup screens, which paint their own dark
   * background whatever the theme: the `dark` class makes the tokens resolve to
   * their dark values inside this element alone. `theme` follows the app's theme.
   */
  tone?: 'theme' | 'onDark';
  /**
   * Open in a new tab — the default, because these links sit beside a form or
   * inside the app, and a page load would lose what was typed there.
   */
  newTab?: boolean;
  /**
   * `rail` for the collapsed sidebar, which has no room for the words: two
   * icon links that keep their names as aria-labels and rail tooltips, so the
   * two pages stay one click away on every screen.
   */
  variant?: 'text' | 'rail';
  className?: string;
}

/**
 * The two links a German commercial site must offer from every page:
 * Impressum and Datenschutz. Plain `<a href>`, not router links: App.tsx
 * matches both paths ahead of every gate on a page load, so the pages render
 * for a signed-out, a blocked and a signed-in visitor alike.
 */
export function LegalLinks({ tone = 'theme', newTab = true, variant = 'text', className }: LegalLinksProps) {
  const { t } = useTranslation();
  const target = newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {};
  const linkClass = cn(
    'rounded-sm text-fg-subtle underline-offset-2 transition-colors hover:text-fg hover:underline',
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
  );

  if (variant === 'rail') {
    const iconLinkClass = cn(
      'flex h-8 w-full items-center justify-center rounded-control text-fg-subtle transition-colors hover:bg-raised hover:text-fg',
      'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus',
    );
    return (
      <nav aria-label={t('legal.links.label')} className={cn('flex flex-col gap-0.5 font-ui', className)}>
        <RailTip rail label={t('legal.link.impressum')}>
          <a href={LEGAL_PATHS.impressum} aria-label={t('legal.link.impressum')} className={iconLinkClass} {...target}>
            <Info size={16} aria-hidden />
          </a>
        </RailTip>
        <RailTip rail label={t('legal.link.privacy')}>
          <a href={LEGAL_PATHS.privacy} aria-label={t('legal.link.privacy')} className={iconLinkClass} {...target}>
            <ShieldCheck size={16} aria-hidden />
          </a>
        </RailTip>
      </nav>
    );
  }

  return (
    <nav
      aria-label={t('legal.links.label')}
      className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 font-ui text-xs', tone === 'onDark' && 'dark', className)}
    >
      <a href={LEGAL_PATHS.impressum} className={linkClass} {...target}>{t('legal.link.impressum')}</a>
      <a href={LEGAL_PATHS.privacy} className={linkClass} {...target}>{t('legal.link.privacy')}</a>
    </nav>
  );
}
