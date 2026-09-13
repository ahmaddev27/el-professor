import { useEffect } from 'react';
import { useTranslation } from '../contexts/LanguageContext';

/**
 * A bar across the top of every screen in any build that is not production.
 *
 * Staging runs on a copy of production data, real accounts and password
 * hashes included, at app.elprofessor.eu — which was production itself until
 * the environments were split. Someone following an old bookmark can therefore
 * sign in to staging with their real password and do real work there that no
 * accountant will ever see. The banner is what tells them, on the login screen
 * before they type anything.
 *
 * It keys off VITE_DEPLOY_ENV, set per GitHub environment at build time, and
 * renders nothing when that is unset — so production and local builds are
 * unaffected unless someone opts in.
 */
const DEPLOY_ENV = (import.meta.env.VITE_DEPLOY_ENV as string | undefined)?.trim() || '';

export default function EnvironmentBanner() {
  const { t } = useTranslation();
  const show = DEPLOY_ENV !== '' && DEPLOY_ENV !== 'production';

  useEffect(() => {
    if (!show) return;
    const prefix = `[${DEPLOY_ENV.toUpperCase()}] `;
    // Tabs are how two environments get confused; mark every title, including
    // the ones screens set later.
    const apply = () => {
      if (!document.title.startsWith(prefix)) document.title = prefix + document.title;
    };
    apply();
    const observer = new MutationObserver(apply);
    const titleEl = document.querySelector('title');
    if (titleEl) observer.observe(titleEl, { childList: true });
    document.body.style.paddingTop = '28px';
    return () => {
      observer.disconnect();
      document.body.style.paddingTop = '';
    };
  }, [show]);

  if (!show) return null;

  return (
    <div
      role="status"
      data-deploy-env={DEPLOY_ENV}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: 28,
        zIndex: 2147483647,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: '0 12px',
        background: '#b45309',
        color: '#ffffff',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '0.02em',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      <span style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}>{DEPLOY_ENV}</span>
      <span aria-hidden="true">·</span>
      <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t('env.banner.notProduction')}</span>
    </div>
  );
}
