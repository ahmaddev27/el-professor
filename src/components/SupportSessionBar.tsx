import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, Eye, LifeBuoy, LogOut } from 'lucide-react';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useToast } from '../contexts/ToastContext';
import {
  contextRefusalMessage,
  isPanelPath,
  pathAfterContextChange,
  supportSessionBar,
  type SupportSessionBar as BarState,
} from '../lib/supportSession';
import { TENANT_HOME } from '../lib/adminGate';
import SupportReasonModal from './SupportReasonModal';

/**
 * The bar a platform account carries while a company is open (plan 3.C, 3.4b).
 *
 * It is the only thing on screen that says a company's data is not the
 * account's own, so it is deliberately loud and always present — in the tenant
 * shell, where the data is, and in the panel, where the session is opened.
 *
 * The two sentences are the plan's, word for word in German:
 *
 *   Support-Zugriff: {Firma} · noch {n} Min · Beenden
 *   Nur-Lese-Ansicht: {Firma} · Support-Sitzung starten
 *
 * English gets an English translation. `src/i18n/index.ts` keeps German only
 * for statutory documents, for a closed list of domain words and for number and
 * date formatting; "Support-Zugriff" is on none of those lists.
 *
 * ## The minute count, and why it ticks here
 *
 * `SuperAdminContext` moves its clock when an answer arrives and when the
 * context's end comes round — not every second, so that every screen in one
 * render is judged by the same moment. A countdown needs its own tick, and this
 * is the only thing that needs it, so it lives here: every fifteen seconds,
 * only while a session is open, and reading the same `expiresAtMs` the gate
 * reads. It changes no state anything else depends on.
 *
 * ## When the context ends by itself
 *
 * Nothing here has to end it, and nothing here can report it: the provider's
 * timer closes the company at the expiry on its own clock,
 * `PlatformAccountGuard` turns the tenant subtree into a <Navigate> in that
 * same render, and this bar unmounts before any effect of its own could run.
 * The sentence that explains the empty panel is raised by the provider, which
 * outlives the navigation.
 */
const SupportSessionBar: React.FC = () => {
  const { platformAccess, activeCompany, openCompany, closeCompany } = useSuperAdmin();
  const { t } = useTranslation();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const [now, setNow] = useState(() => Date.now());
  const [askingReason, setAskingReason] = useState(false);
  const [busy, setBusy] = useState(false);

  const bar = supportSessionBar(platformAccess, now);

  // A countdown, and only while there is one to count.
  useEffect(() => {
    if (bar.kind === 'none') return;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [bar.kind]);

  if (bar.kind === 'none') return null;

  const companyName = bar.companyName || activeCompany?.name || t('support.bar.unknownCompany');

  const goAfter = (before: BarState['kind'], after: 'view' | 'support' | null) => {
    const path = pathAfterContextChange(
      before === 'none' ? null : before,
      after,
      location.pathname,
    );
    if (path) navigate(path, { replace: true });
  };

  const end = async () => {
    setBusy(true);
    try {
      await closeCompany();
      goAfter(bar.kind, null);
    } catch (error) {
      showToast('error', contextRefusalMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  const raiseToSupport = async (reason: string) => {
    if (!activeCompany) return;
    setBusy(true);
    try {
      await openCompany(activeCompany, 'support', reason);
      setAskingReason(false);
      showToast('success', t('support.bar.startedTitle', { company: companyName }));
    } catch (error) {
      showToast('error', contextRefusalMessage(error, t));
    } finally {
      setBusy(false);
    }
  };

  const support = bar.kind === 'support';
  const tone = support ? 'var(--warning)' : 'var(--accent)';

  return (
    <>
      <div
        className="px-4 py-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium"
        style={{
          background: support ? 'var(--warning-subtle)' : 'var(--bg-subtle)',
          borderBottom: `1px solid ${tone}`,
          color: tone,
        }}
        role="status"
      >
        {support ? <LifeBuoy size={16} /> : <Eye size={16} />}
        <span>
          {t(support ? 'support.bar.supportLabel' : 'support.bar.viewLabel')}: {companyName}
        </span>

        {support && (
          <>
            <span aria-hidden="true">·</span>
            {/* tabular-nums: the figure changes every minute and must not
                shuffle the words beside it. */}
            <span className="tabular-nums">
              {t('support.bar.minutesLeft', { minutes: bar.minutesLeft })}
            </span>
          </>
        )}

        {!support && bar.canStartSupport && (
          <>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => setAskingReason(true)}
              className="underline underline-offset-2 disabled:opacity-50"
            >
              {t('support.bar.startSupport')}
            </button>
          </>
        )}

        {/* In the panel the bar names a company that is not on screen, so it
            offers the way in. A reload of a tenant address lands back on that
            screen by itself — the guard no longer redirects it — so this is for
            the person who navigated to /admin with a session still open, and
            for a reload of /admin itself. */}
        {isPanelPath(location.pathname) && (
          <>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => navigate(TENANT_HOME)}
              className="inline-flex items-center gap-1 underline underline-offset-2 disabled:opacity-50"
            >
              <ArrowRight size={14} />
              {t('support.bar.openCompanyView')}
            </button>
          </>
        )}

        <span aria-hidden="true">·</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => { void end(); }}
          className="inline-flex items-center gap-1 underline underline-offset-2 disabled:opacity-50"
        >
          <LogOut size={14} />
          {t('support.bar.end')}
        </button>
      </div>

      {askingReason && (
        <SupportReasonModal
          companyName={companyName}
          busy={busy}
          onCancel={() => setAskingReason(false)}
          onConfirm={reason => { void raiseToSupport(reason); }}
        />
      )}
    </>
  );
};

export default SupportSessionBar;
