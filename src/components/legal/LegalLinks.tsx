import { useTranslation } from '../../contexts/LanguageContext';
import { LEGAL_PATHS } from '../../lib/legalPages';
import { cn } from '../ui/cn';

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
  className?: string;
}

/**
 * The two links a German commercial site must offer from every page:
 * Impressum and Datenschutz. Plain `<a href>`, not router links: App.tsx
 * matches both paths ahead of every gate on a page load, so the pages render
 * for a signed-out, a blocked and a signed-in visitor alike.
 */
export function LegalLinks({ tone = 'theme', newTab = true, className }: LegalLinksProps) {
  const { t } = useTranslation();
  const target = newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {};
  const linkClass = cn(
    'rounded-sm text-fg-subtle underline-offset-2 transition-colors hover:text-fg hover:underline',
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
  );

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
