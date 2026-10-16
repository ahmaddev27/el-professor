import React, { useCallback, useEffect, useState } from 'react';
import { MailCheck, Save } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import { parseNotificationAddress, storedNotificationAddress } from '../../supabase/functions/_shared/notification-recipients';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Input } from './ui';

/**
 * The address El-Professor's company-level mail is sent to (owner request 15.10.2026).
 *
 * One nullable column, `company_settings.notification_email`, saved here with its
 * own button for the same reason the Abrechnung card has one: it sits beside the
 * settings form, not in it. When it is set it REPLACES the company's
 * administrators as the recipients of the Abrechnung summary and the TÜV
 * notices; when it is empty the administrators receive them. Driver mail
 * is never affected. The rule is `chooseCompanyRecipients` in
 * supabase/functions/_shared/notification-recipients.ts, and the card says it
 * in words before anything is saved.
 *
 * Empty is stored as NULL: the column's CHECK refuses an empty string.
 */
const NotificationAddressCard: React.FC<{ readOnly: boolean }> = ({ readOnly }) => {
  const { t } = useTranslation();
  const { success, error: showError } = useToast();
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const [value, setValue] = useState('');
  /** The stored address, or null for "not set". Only meaningful once loaded. */
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setLoadFailed(false);
    const { data, error } = await supabase
      .from('company_settings')
      .select('notification_email')
      .eq('company_id', companyId)
      .maybeSingle();
    if (error) {
      setLoadFailed(true);
    } else {
      const stored = storedNotificationAddress(data?.notification_email);
      setSaved(stored);
      setValue(stored ?? '');
    }
    setLoading(false);
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  const parsed = parseNotificationAddress(value);
  const dirty = (parsed.kind === 'valid' ? parsed.value : parsed.kind === 'empty' ? null : value) !== saved;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyId || parsed.kind === 'invalid') return;
    setSaving(true);
    const { error } = await supabase
      .from('company_settings')
      .upsert(
        { company_id: companyId, notification_email: parsed.kind === 'valid' ? parsed.value : null },
        { onConflict: 'company_id' },
      );
    setSaving(false);
    if (error) {
      showError(t('settings.notifyAddress.saveFailed'), t('settings.notifyAddress.saveFailedBody'));
      return;
    }
    success(t('settings.notifyAddress.saved'), t('settings.notifyAddress.savedBody'));
    await load();
  };

  // A failed read is not "no address set": the field would say administrators
  // receive the mail while the stored row may redirect it elsewhere.
  const body = loadFailed ? (
    <Alert tone="critical" title={t('settings.notifyAddress.loadFailed')}>
      <Button type="button" variant="secondary" onClick={load}>{t('settings.notifyAddress.retry')}</Button>
    </Alert>
  ) : (
    <form onSubmit={handleSave} className="grid grid-cols-1 gap-4">
      <p className="text-sm text-fg-muted">{t('settings.notifyAddress.description')}</p>

      <fieldset disabled={readOnly || loading || saving} className="m-0 grid min-w-0 grid-cols-1 gap-4 border-0 p-0">
        <Field
          label={t('settings.notifyAddress.label')}
          id="notify-address"
          hint={t('settings.notifyAddress.hint')}
          error={parsed.kind === 'invalid' ? t('settings.notifyAddress.invalid') : undefined}
        >
          <Input
            id="notify-address"
            type="email"
            inputMode="email"
            autoComplete="off"
            placeholder={t('settings.notifyAddress.placeholder')}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>

        {!loading && (
          <p aria-live="polite" className="text-sm text-fg">
            {parsed.kind === 'valid'
              ? t('settings.notifyAddress.effect.address', { address: parsed.value })
              : t('settings.notifyAddress.effect.admins')}
            {dirty && <span className="block text-xs text-fg-subtle">{t('settings.notifyAddress.unsaved')}</span>}
          </p>
        )}

        <div className="flex justify-end">
          <Button type="submit" disabled={readOnly || loading || saving || parsed.kind === 'invalid' || !dirty}>
            <Save aria-hidden />
            <span>{t('common.save')}</span>
          </Button>
        </div>
      </fieldset>
    </form>
  );

  return (
    <Card>
      <CardHeader className="justify-start gap-2">
        <MailCheck aria-hidden className="size-5 text-brand-text" />
        <CardTitle>{t('settings.notifyAddress.title')}</CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
};

export default NotificationAddressCard;
