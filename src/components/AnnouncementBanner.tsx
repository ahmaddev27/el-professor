import React, { useEffect, useState } from 'react';
import { Info, AlertTriangle, X } from 'lucide-react';
import { useAppConfig } from '../contexts/AppConfigContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { Language } from '../i18n';
import {
  announcementText,
  dismissalKey,
  isShowing,
  type Announcement,
} from '../lib/announcements';

/**
 * The platform's announcements (plan 3.11), above every tenant screen.
 *
 * The database has already chosen them: `get_app_config()` returns only those
 * whose audience includes this company and whose window is open. The banner
 * adds two things of its own. It takes an announcement down at its end without
 * waiting for the next configuration read, because a tab stays open for hours.
 * And it remembers, in this browser only, that the reader closed one — keyed by
 * its version, so a corrected announcement comes back.
 *
 * Nothing shows while the configuration for the current account is still
 * loading: the answer being replaced may belong to the account before it.
 */

const TONE_STYLE: Record<Announcement['tone'], { bg: string; color: string; Icon: React.ElementType }> = {
  info:    { bg: 'var(--accent-subtle)',  color: 'var(--accent)',  Icon: Info },
  warning: { bg: 'var(--warning-subtle)', color: 'var(--warning)', Icon: AlertTriangle },
};

function wasDismissed(a: Announcement): boolean {
  try {
    return localStorage.getItem(dismissalKey(a)) === '1';
  } catch {
    // Private windows and blocked storage: the banner shows, which is the safe side.
    return false;
  }
}

function rememberDismissal(a: Announcement): void {
  try {
    localStorage.setItem(dismissalKey(a), '1');
  } catch {
    // Not remembered: it comes back on the next load, and nothing else is lost.
  }
}

/** One announcement, as a tenant sees it. The settings screen's preview renders the same. */
export const AnnouncementItem: React.FC<{
  announcement: Announcement;
  language: Language;
  dismissLabel: string;
  onDismiss?: () => void;
}> = ({ announcement, language, dismissLabel, onDismiss }) => {
  const { bg, color, Icon } = TONE_STYLE[announcement.tone];
  const { title, body } = announcementText(announcement, language);
  return (
    <div
      className="flex items-start justify-between gap-3 px-4 py-2.5 text-xs"
      style={{ background: bg, borderBottom: `1px solid ${color}22`, color }}
    >
      <div className="flex items-start gap-2 min-w-0">
        <Icon size={14} className="flex-shrink-0 mt-px" />
        <p className="min-w-0 break-words">
          <span className="font-semibold">{title}</span>
          <span style={{ color: 'var(--text-secondary)' }}> — {body}</span>
        </p>
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="p-0.5 rounded flex-shrink-0 transition-opacity hover:opacity-60"
          style={{ color }}
          aria-label={dismissLabel}
          title={dismissLabel}
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
};

const AnnouncementBanner: React.FC = () => {
  const { announcements, loading } = useAppConfig();
  const { language, t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  // Bumped on a dismissal, so the list is filtered again against storage.
  const [, setDismissals] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  if (loading) return null;
  const visible = announcements.filter(a => isShowing(a, now) && !wasDismissed(a));
  if (visible.length === 0) return null;

  return (
    <div role="region" aria-label={t('announcement.region')}>
      {visible.map(a => (
        <AnnouncementItem
          key={`${a.id}:${a.version}`}
          announcement={a}
          language={language}
          dismissLabel={t('announcement.dismiss')}
          onDismiss={() => {
            rememberDismissal(a);
            setDismissals(n => n + 1);
          }}
        />
      ))}
    </div>
  );
};

export default AnnouncementBanner;
