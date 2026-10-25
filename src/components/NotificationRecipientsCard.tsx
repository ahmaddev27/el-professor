import React, { useCallback, useEffect, useState } from 'react';
import { Mails, Plus, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { deleteChecked, type WriteOutcome } from '../lib/writeOutcome';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import {
  MAX_ADDRESSES_PER_KIND,
  RECIPIENT_KINDS,
  addressesForKind,
  parseNotificationAddress,
  storedNotificationAddress,
  type RecipientKind,
  type RecipientRow,
} from '../../supabase/functions/_shared/notification-recipients';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Input } from './ui';

/**
 * Which addresses receive which kind of company mail (owner request 15.10.2026).
 *
 * One row per address in `notification_recipients`. A kind with at least one
 * address sends to exactly those; a kind with none falls back to the company's
 * single notification address and then to its administrators (the precedence is
 * `chooseCompanyRecipients`, shared with the job). Every add and every remove is
 * saved at once, so there is no unsaved state to lose: removing the last address
 * of a kind is how a company goes back to the fallback, and the sentence under
 * each kind says what that is right now.
 */
interface StoredRow extends RecipientRow {
  id: string;
  email: string;
}

const KIND_LABEL_KEYS = {
  tuev_bald_ablaufend: 'settings.notifyRecipients.kind.tuev_bald_ablaufend',
  tuev_abgelaufen: 'settings.notifyRecipients.kind.tuev_abgelaufen',
  manager_summary: 'settings.notifyRecipients.kind.manager_summary',
} as const satisfies Record<RecipientKind, string>;

const NotificationRecipientsCard: React.FC<{ readOnly: boolean }> = ({ readOnly }) => {
  const { t } = useTranslation();
  const { success, error: showError } = useToast();
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const [rows, setRows] = useState<StoredRow[]>([]);
  /** The single company address the lists fall back to, or null. */
  const [fallback, setFallback] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<RecipientKind, string>>>({});
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setLoadFailed(false);
    const [listed, settings] = await Promise.all([
      supabase
        .from('notification_recipients')
        .select('id, notification_type, email')
        .eq('company_id', companyId)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true }),
      supabase.from('company_settings').select('notification_email').eq('company_id', companyId).maybeSingle(),
    ]);
    if (listed.error || settings.error) {
      setLoadFailed(true);
    } else {
      setRows((listed.data ?? []) as StoredRow[]);
      setFallback(storedNotificationAddress(settings.data?.notification_email));
    }
    setLoading(false);
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  const draftOf = (kind: RecipientKind) => drafts[kind] ?? '';
  const setDraft = (kind: RecipientKind, value: string) => setDrafts((prev) => ({ ...prev, [kind]: value }));

  const problemFor = (kind: RecipientKind): string | undefined => {
    const parsed = parseNotificationAddress(draftOf(kind));
    if (parsed.kind === 'invalid') return t('settings.notifyRecipients.invalid');
    if (parsed.kind === 'valid'
      && addressesForKind(rows, kind).some((a) => a.toLowerCase() === parsed.value.toLowerCase())) {
      return t('settings.notifyRecipients.duplicate');
    }
    return undefined;
  };

  const add = async (kind: RecipientKind) => {
    const parsed = parseNotificationAddress(draftOf(kind));
    if (!companyId || parsed.kind !== 'valid' || problemFor(kind)) return;
    setBusy(true);
    const { error } = await supabase
      .from('notification_recipients')
      .insert({ company_id: companyId, notification_type: kind, email: parsed.value });
    setBusy(false);
    if (error) {
      showError(t('settings.notifyRecipients.saveFailed'), t('settings.notifyRecipients.saveFailedBody'));
      return;
    }
    setDraft(kind, '');
    success(t('settings.notifyRecipients.added'), t('settings.notifyRecipients.addedBody', { address: parsed.value }));
    await load();
  };

  const remove = async (row: StoredRow) => {
    setBusy(true);
    let outcome: WriteOutcome | 'error' = 'error';
    try {
      outcome = await deleteChecked(supabase, 'notification_recipients', q => q.eq('id', row.id));
    } catch {
      outcome = 'error';
    }
    setBusy(false);
    if (outcome === 'error') {
      showError(t('settings.notifyRecipients.removeFailed'), t('settings.notifyRecipients.saveFailedBody'));
      return;
    }
    if (outcome !== 'done') {
      if (outcome === 'gone') await load();
      showError(t('settings.notifyRecipients.removeFailed'), t(outcome === 'gone' ? 'common.writeAlreadyGone' : 'common.writeRefused'));
      return;
    }
    success(t('settings.notifyRecipients.removed'), t('settings.notifyRecipients.removedBody', { address: row.email }));
    await load();
  };

  const effectFor = (kind: RecipientKind): string => {
    if (addressesForKind(rows, kind).length > 0) return t('settings.notifyRecipients.effect.listed');
    return fallback
      ? t('settings.notifyRecipients.effect.single', { address: fallback })
      : t('settings.notifyRecipients.effect.admins');
  };

  const renderKind = (kind: RecipientKind) => {
    const listed = rows.filter((row) => row.notification_type === kind);
    const inputId = `recipient-${kind}`;
    const full = listed.length >= MAX_ADDRESSES_PER_KIND;
    const draft = parseNotificationAddress(draftOf(kind));
    return (
      <section key={kind} className="grid grid-cols-1 gap-3 border-t border-line pt-4 first:border-t-0 first:pt-0">
        <h3 className="text-sm font-semibold text-fg">{t(KIND_LABEL_KEYS[kind])}</h3>
        {listed.length > 0 && (
          <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0">
            {listed.map((row) => (
              <li key={row.id} className="flex min-w-0 items-center justify-between gap-2 rounded-md bg-sunken px-3 py-2">
                <span className="min-w-0 break-all text-sm text-fg">{row.email}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={readOnly || busy}
                  aria-label={t('settings.notifyRecipients.remove', { address: row.email })}
                  onClick={() => remove(row)}
                >
                  <X aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-start"
          onSubmit={(e) => { e.preventDefault(); add(kind); }}
        >
          <Field label={t('settings.notifyRecipients.label')} id={inputId} error={problemFor(kind)}>
            <Input
              id={inputId}
              type="email"
              inputMode="email"
              autoComplete="off"
              placeholder={t('settings.notifyRecipients.placeholder')}
              value={draftOf(kind)}
              disabled={readOnly || busy || full}
              onChange={(e) => setDraft(kind, e.target.value)}
            />
          </Field>
          <Button
            type="submit"
            variant="secondary"
            className="sm:mt-6"
            disabled={readOnly || busy || full || draft.kind !== 'valid' || problemFor(kind) !== undefined}
          >
            <Plus aria-hidden />
            <span>{t('settings.notifyRecipients.add')}</span>
          </Button>
        </form>
        {full && <p className="text-xs text-fg-subtle">{t('settings.notifyRecipients.full', { max: MAX_ADDRESSES_PER_KIND })}</p>}
        <p aria-live="polite" className="text-sm text-fg-muted">{effectFor(kind)}</p>
      </section>
    );
  };

  // A failed read is not "nothing listed": every sentence below would then say
  // the administrators receive the mail while the stored rows may say otherwise.
  const body = loadFailed ? (
    <Alert tone="critical" title={t('settings.notifyRecipients.loadFailed')}>
      <Button type="button" variant="secondary" onClick={load}>{t('settings.notifyRecipients.retry')}</Button>
    </Alert>
  ) : (
    <div className="grid grid-cols-1 gap-4">
      <p className="text-sm text-fg-muted">{t('settings.notifyRecipients.description')}</p>
      {!loading && RECIPIENT_KINDS.map(renderKind)}
    </div>
  );

  return (
    <Card>
      <CardHeader className="justify-start gap-2">
        <Mails aria-hidden className="size-5 text-brand-text" />
        <CardTitle>{t('settings.notifyRecipients.title')}</CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
};

export default NotificationRecipientsCard;
