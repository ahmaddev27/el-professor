import { useCallback, useEffect, useState, type FC } from 'react';
import { FileText } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';
import LanguageSwitcher from '../components/LanguageSwitcher';
import { Alert, Button, Card, EmptyState, Skeleton } from '../components/ui';
import { ImpressumDocument, PrivacyDocument } from '../components/legal/LegalDocument';
import { LegalLinks } from '../components/legal/LegalLinks';
import {
  LEGAL_TITLES,
  impressumIsPublished,
  privacyIsPublished,
  type LegalPageKind,
  type LegalPages,
} from '../lib/legalPages';
import { getLegalPages } from '../lib/legalPagesClient';

/**
 * `/impressum` and `/datenschutz` (migration 20260921120000).
 *
 * App.tsx renders this ahead of every gate — before the session is known, and
 * for a blocked or unapproved company too — because a German commercial site
 * owes both pages to everyone, and neither reads anything but public data.
 *
 * Nothing on it is invented: every fact is one the owner entered, a field
 * nobody filled is not shown, and a page with nothing entered says so plainly.
 * A load that failed says that instead, rather than an empty Impressum that
 * would read as "nothing to declare".
 */

export type LegalPageState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; pages: LegalPages };

const LegalPage: FC<{ page: LegalPageKind }> = ({ page }) => {
  const [state, setState] = useState<LegalPageState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', pages: await getLegalPages() });
    } catch {
      setState({ status: 'failed' });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const before = document.title;
    document.title = `${LEGAL_TITLES[page]} – El-Professor`;
    return () => { document.title = before; };
  }, [page]);

  return <LegalPageView page={page} state={state} onRetry={() => void load()} />;
};

// ─── Presentation ────────────────────────────────────────────────────────────

/** The page as drawn; the design harness renders it on invented data. */
export function LegalPageView({ page, state, onRetry }: {
  page: LegalPageKind;
  state: LegalPageState;
  onRetry: () => void;
}) {
  const { t, language } = useTranslation();

  return (
    <div className="flex min-h-screen flex-col bg-canvas font-ui text-fg">
      <header className="border-b border-line bg-raised">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <a
            href="/"
            aria-label={t('legal.backHome')}
            className="flex min-w-0 items-center gap-2.5 rounded-control focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <img src="/brand/mark-on-light.png" alt="" className="h-7 w-auto dark:hidden" />
            <img src="/brand/mark-on-dark.png" alt="" className="hidden h-7 w-auto dark:block" />
            <img src="/brand/wordmark-on-light.png" alt="El-Professor" className="h-4 w-auto dark:hidden" />
            <img src="/brand/wordmark-on-dark.png" alt="El-Professor" className="hidden h-4 w-auto dark:block" />
          </a>
          <LanguageSwitcher />
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        <h1 lang="de" className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl">
          {LEGAL_TITLES[page]}
        </h1>
        {language === 'en' ? <p className="mt-2 text-sm text-fg-muted">{t('legal.germanOnly')}</p> : null}

        <div className="mt-6 sm:mt-8">
          <LegalPageBody page={page} state={state} onRetry={onRetry} />
        </div>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-3 px-4 py-6 sm:px-6">
          <a
            href="/"
            className="rounded-sm text-xs text-fg-subtle underline-offset-2 hover:text-fg hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {t('legal.backHome')}
          </a>
          <LegalLinks newTab={false} />
        </div>
      </footer>
    </div>
  );
}

function LegalPageBody({ page, state, onRetry }: {
  page: LegalPageKind;
  state: LegalPageState;
  onRetry: () => void;
}) {
  const { t } = useTranslation();

  if (state.status === 'loading') {
    return (
      <Card className="space-y-3 p-5 sm:p-8" aria-busy="true" aria-label={t('legal.loading')}>
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-4/5" />
      </Card>
    );
  }

  if (state.status === 'failed') {
    return (
      <Alert
        tone="critical"
        title={t('legal.loadFailed.title')}
        action={<Button variant="secondary" size="sm" onClick={onRetry}>{t('legal.retry')}</Button>}
      >
        {t('legal.loadFailed.body')}
      </Alert>
    );
  }

  const { impressum, privacy } = state.pages;
  const published = page === 'impressum' ? impressumIsPublished(impressum) : privacyIsPublished(privacy);

  if (!published) {
    return (
      <Card>
        <EmptyState
          icon={FileText}
          title={t(page === 'impressum' ? 'legal.impressum.empty.title' : 'legal.privacy.empty.title')}
          description={t('legal.empty.body')}
        />
      </Card>
    );
  }

  return (
    <Card className="p-5 sm:p-8">
      {page === 'impressum' ? <ImpressumDocument impressum={impressum} /> : <PrivacyDocument privacy={privacy} />}
    </Card>
  );
}

export default LegalPage;
