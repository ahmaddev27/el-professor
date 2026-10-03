import React, { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Save } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, NativeSelect } from './ui';

/**
 * When the weekly Abrechnung is mailed, and to whom (plan: owner request 03.10.2026).
 *
 * One row per company in `abrechnung_schedules`: two switches, a weekday and a
 * Europe/Berlin time. The mailing itself is the edge function's job, driven by a
 * host cron line; this card only edits the row, as the company's administrator
 * (the table's write policies ask for one, and the screen is only registered for
 * administrators). It has its own save because the row is not part of
 * `company_settings`, and sits outside the settings form because a form may not
 * nest in a form.
 *
 * Weekday numbers are PostgreSQL's: 0 is Sunday. The picker lists Monday first.
 */

/** The order the picker lists them in, as stored values (0 = Sunday). */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const WEEKDAY_KEYS = [
  'stn.weekday.sunday', 'stn.weekday.monday', 'stn.weekday.tuesday', 'stn.weekday.wednesday',
  'stn.weekday.thursday', 'stn.weekday.friday', 'stn.weekday.saturday',
] as const;

interface ScheduleForm {
  driverMail: boolean;
  managerSummary: boolean;
  weekday: number;
  /** `HH:MM`, the value an `<input type="time">` holds. */
  time: string;
}

const DEFAULTS: ScheduleForm = { driverMail: false, managerSummary: false, weekday: 1, time: '08:00' };

const checkboxClass = 'mt-1 size-4 shrink-0 cursor-pointer accent-brand disabled:cursor-not-allowed';

const AbrechnungScheduleCard: React.FC<{ readOnly: boolean }> = ({ readOnly }) => {
  const { t } = useTranslation();
  const { success, error: showError } = useToast();
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const [form, setForm] = useState<ScheduleForm>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setLoadFailed(false);
    const { data, error } = await supabase
      .from('abrechnung_schedules')
      .select('driver_mail_enabled, manager_summary_enabled, weekday, send_time')
      .eq('company_id', companyId)
      .maybeSingle();
    if (error) {
      setLoadFailed(true);
    } else if (data) {
      setForm({
        driverMail: data.driver_mail_enabled,
        managerSummary: data.manager_summary_enabled,
        weekday: data.weekday,
        time: String(data.send_time).slice(0, 5),
      });
    } else {
      setForm(DEFAULTS);
    }
    setLoading(false);
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyId) return;
    setSaving(true);
    const { error } = await supabase
      .from('abrechnung_schedules')
      .upsert({
        company_id: companyId,
        driver_mail_enabled: form.driverMail,
        manager_summary_enabled: form.managerSummary,
        weekday: form.weekday,
        send_time: form.time,
      }, { onConflict: 'company_id' });
    setSaving(false);
    if (error) {
      showError(t('settings.abrSchedule.saveFailed'), t('settings.abrSchedule.saveFailedBody'));
      return;
    }
    success(t('settings.abrSchedule.saved'), t('settings.abrSchedule.savedBody'));
  };

  // A failed read is not "everything off": the form would show switches that
  // say nothing is sent while the stored row may say otherwise.
  const body = loadFailed ? (
    <Alert tone="critical" title={t('settings.abrSchedule.loadFailed')}>
      <Button type="button" variant="secondary" onClick={load}>{t('settings.abrSchedule.retry')}</Button>
    </Alert>
  ) : (
    <form onSubmit={handleSave} className="grid grid-cols-1 gap-4">
      <p className="text-sm text-fg-muted">{t('settings.abrSchedule.description')}</p>

      <fieldset disabled={readOnly || loading || saving} className="m-0 grid min-w-0 grid-cols-1 gap-4 border-0 p-0">
        <label className="flex cursor-pointer items-start gap-3 text-sm text-fg">
          <input
            type="checkbox"
            className={checkboxClass}
            checked={form.driverMail}
            onChange={(e) => setForm({ ...form, driverMail: e.target.checked })}
          />
          <span>
            <span className="block font-medium">{t('settings.abrSchedule.drivers.label')}</span>
            <span className="block text-fg-subtle">{t('settings.abrSchedule.drivers.hint')}</span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-3 text-sm text-fg">
          <input
            type="checkbox"
            className={checkboxClass}
            checked={form.managerSummary}
            onChange={(e) => setForm({ ...form, managerSummary: e.target.checked })}
          />
          <span>
            <span className="block font-medium">{t('settings.abrSchedule.manager.label')}</span>
            <span className="block text-fg-subtle">{t('settings.abrSchedule.manager.hint')}</span>
          </span>
        </label>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label={t('settings.abrSchedule.weekday')} id="abr-schedule-weekday">
            <NativeSelect
              id="abr-schedule-weekday"
              value={form.weekday}
              onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}
            >
              {WEEKDAY_ORDER.map((day) => (
                <option key={day} value={day}>{t(WEEKDAY_KEYS[day])}</option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t('settings.abrSchedule.time')} hint={t('settings.abrSchedule.timeHint')} id="abr-schedule-time">
            <Input
              id="abr-schedule-time"
              type="time"
              required
              value={form.time}
              onChange={(e) => setForm({ ...form, time: e.target.value })}
            />
          </Field>
        </div>

        {!form.driverMail && !form.managerSummary && (
          <p className="text-sm text-fg-subtle">{t('settings.abrSchedule.nothingOn')}</p>
        )}
        <p className="text-xs text-fg-subtle">{t('settings.abrSchedule.changeNote')}</p>

        <div className="flex justify-end">
          <Button type="submit" disabled={readOnly || loading || saving || !form.time}>
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
        <CalendarClock aria-hidden className="size-5 text-brand-text" />
        <CardTitle>{t('settings.abrSchedule.title')}</CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
};

export default AbrechnungScheduleCard;
