import React, { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Save } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import {
  judgePreview, nextOccurrence, parsePreviewAnswer,
  type ChannelState, type NextOccurrence, type SchedulePreviewAnswer,
} from '../utils/abrechnungSchedulePreview';
import {
  germanDay,
  nextMoments,
  REMINDER_LEAD_DEFAULT_MINUTES,
  REMINDER_LEAD_MAX_MINUTES,
  REMINDER_LEAD_MIN_MINUTES,
} from '../../supabase/functions/_shared/abrechnung-schedule-core';
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
  /** Remind a driver who recorded nothing, `reminderLead` minutes before the driver mail. */
  reminder: boolean;
  reminderLead: number;
}

const DEFAULTS: ScheduleForm = {
  driverMail: false, managerSummary: false, weekday: 1, time: '08:00',
  reminder: false, reminderLead: REMINDER_LEAD_DEFAULT_MINUTES,
};

/** The leads the picker offers. A stored value outside this list is added to it, never lost. */
const REMINDER_LEADS = [15, 30, 60, 90, 120, 180, 360, 720, 840, 1080, 1440] as const;

/** From four hours on, a whole number of hours reads better than minutes. */
const HOURS_FROM_MINUTES = 240;

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; next: NextOccurrence; answer: SchedulePreviewAnswer };

const checkboxClass = 'mt-1 size-4 shrink-0 cursor-pointer accent-brand disabled:cursor-not-allowed';

function leadOptions(current: number): number[] {
  const all = new Set<number>([...REMINDER_LEADS, current]);
  return [...all]
    .filter((m) => m >= REMINDER_LEAD_MIN_MINUTES && m <= REMINDER_LEAD_MAX_MINUTES)
    .sort((a, b) => a - b);
}

const AbrechnungScheduleCard: React.FC<{ readOnly: boolean }> = ({ readOnly }) => {
  const { t } = useTranslation();
  const { success, error: showError } = useToast();
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const [form, setForm] = useState<ScheduleForm>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  /** The stored row: null when the company has none. The preview describes this, not the form. */
  const [saved, setSaved] = useState<ScheduleForm | null>(null);
  /** When the stored row last changed: a moment at or before it never fires (the job's rule 3). */
  const [armedAt, setArmedAt] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setLoadFailed(false);
    const { data, error } = await supabase
      .from('abrechnung_schedules')
      .select('driver_mail_enabled, manager_summary_enabled, weekday, send_time, reminder_enabled, reminder_lead_minutes, armed_at')
      .eq('company_id', companyId)
      .maybeSingle();
    if (error) {
      setLoadFailed(true);
    } else if (data) {
      const stored: ScheduleForm = {
        driverMail: data.driver_mail_enabled,
        managerSummary: data.manager_summary_enabled,
        weekday: data.weekday,
        time: String(data.send_time).slice(0, 5),
        reminder: data.reminder_enabled,
        reminderLead: data.reminder_lead_minutes,
      };
      setForm(stored);
      setSaved(stored);
      setArmedAt(data.armed_at ?? null);
    } else {
      setForm(DEFAULTS);
      setSaved(null);
      setArmedAt(null);
    }
    setLoading(false);
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  // What the next send would do, from the same SQL the job reads. Only for a
  // saved schedule with a switch on: otherwise the answer is known without asking.
  const loadPreview = useCallback(async () => {
    const next = saved && (saved.driverMail || saved.managerSummary)
      ? nextOccurrence(saved.weekday, saved.time, new Date())
      : null;
    if (!next) { setPreview({ status: 'idle' }); return; }
    setPreview({ status: 'loading' });
    const { data, error } = await supabase.rpc('abrechnung_schedule_preview', { p_week_monday: next.weekMonday });
    const answer = error ? null : parsePreviewAnswer(data);
    setPreview(answer ? { status: 'ready', next, answer } : { status: 'failed' });
  }, [saved]);

  useEffect(() => { loadPreview(); }, [loadPreview]);

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
        // The reminder warns about the drivers' mail, so it is stored off with it.
        reminder_enabled: form.driverMail && form.reminder,
        reminder_lead_minutes: form.reminderLead,
      }, { onConflict: 'company_id' });
    setSaving(false);
    if (error) {
      showError(t('settings.abrSchedule.saveFailed'), t('settings.abrSchedule.saveFailedBody'));
      return;
    }
    success(t('settings.abrSchedule.saved'), t('settings.abrSchedule.savedBody'));
    await load();
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
            checked={form.driverMail && form.reminder}
            disabled={!form.driverMail}
            onChange={(e) => setForm({ ...form, reminder: e.target.checked })}
          />
          <span>
            <span className="block font-medium">{t('settings.abrSchedule.reminder.label')}</span>
            <span className="block text-fg-subtle">
              {t('settings.abrSchedule.reminder.hint')}
            </span>
          </span>
        </label>

        {form.driverMail && form.reminder && (
          <Field label={t('settings.abrSchedule.reminder.lead')} id="abr-schedule-reminder-lead">
            <NativeSelect
              id="abr-schedule-reminder-lead"
              value={form.reminderLead}
              onChange={(e) => setForm({ ...form, reminderLead: Number(e.target.value) })}
            >
              {leadOptions(form.reminderLead).map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes >= HOURS_FROM_MINUTES && minutes % 60 === 0
                    ? t('settings.abrSchedule.reminder.leadOptionHours', { hours: minutes / 60 })
                    : t('settings.abrSchedule.reminder.leadOption', { minutes })}
                </option>
              ))}
            </NativeSelect>
          </Field>
        )}

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

        <SchedulePreview
          saved={saved}
          armedAt={armedAt}
          loading={loading}
          preview={preview}
          dirty={JSON.stringify(form) !== JSON.stringify(saved ?? DEFAULTS)}
          onRetry={loadPreview}
        />

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

interface SchedulePreviewProps {
  saved: ScheduleForm | null;
  armedAt: string | null;
  loading: boolean;
  preview: PreviewState;
  dirty: boolean;
  onRetry: () => void;
}

/**
 * The statement of what the next send does. An empty preview and a confident
 * "0 drivers" are different claims: a failed load shows the failure and no figure.
 */
const SchedulePreview: React.FC<SchedulePreviewProps> = ({ saved, armedAt, loading, preview, dirty, onRetry }) => {
  const { t } = useTranslation();
  if (loading) return null;

  let body: React.ReactNode;
  if (saved === null) {
    body = <p>{t('settings.abrSchedule.preview.notScheduled')}</p>;
  } else if (!saved.driverMail && !saved.managerSummary) {
    body = <p>{t('settings.abrSchedule.preview.bothOff')}</p>;
  } else if (preview.status === 'loading' || preview.status === 'idle') {
    body = <p>{t('settings.abrSchedule.preview.loading')}</p>;
  } else if (preview.status === 'failed') {
    body = (
      <Alert tone="critical" title={t('settings.abrSchedule.preview.loadFailed')}>
        <Button type="button" variant="secondary" onClick={onRetry}>{t('settings.abrSchedule.retry')}</Button>
      </Alert>
    );
  } else {
    body = <PreviewBody next={preview.next} answer={preview.answer} saved={saved} armedAt={armedAt} />;
  }

  return (
    <section aria-live="polite" className="grid grid-cols-1 gap-2 rounded-md border border-border bg-canvas p-4 text-sm text-fg">
      <h3 className="font-medium">{t('settings.abrSchedule.preview.title')}</h3>
      {body}
      {dirty && <p className="text-xs text-fg-subtle">{t('settings.abrSchedule.preview.savedNote')}</p>}
    </section>
  );
};

const SKIP_KEYS = {
  noEmail: 'settings.abrSchedule.preview.skip.noEmail',
  ambiguous: 'settings.abrSchedule.preview.skip.ambiguous',
  inactive: 'settings.abrSchedule.preview.skip.inactive',
  noDriver: 'settings.abrSchedule.preview.skip.noDriver',
  claimed: 'settings.abrSchedule.preview.skip.claimed',
} as const;

interface PreviewBodyProps {
  next: NextOccurrence;
  answer: SchedulePreviewAnswer;
  saved: ScheduleForm;
  armedAt: string | null;
}

const PreviewBody: React.FC<PreviewBodyProps> = ({ next, answer, saved, armedAt }) => {
  const { t, tPlural } = useTranslation();
  // The saved schedule's reminder, by the job's own rules; a reminder moment the
  // schedule was armed after is not offered, so the line names the week it really fires.
  const reminder = armedAt
    ? nextMoments({
      weekday: saved.weekday, send_time: saved.time, armed_at: armedAt,
      reminder_lead_minutes: saved.reminderLead,
      reminder_enabled: saved.reminder, driver_mail_enabled: saved.driverMail,
    }, new Date())?.reminder ?? null
    : null;
  const verdict = judgePreview(answer, saved.driverMail, saved.managerSummary);
  const skips: Array<[keyof typeof SKIP_KEYS, number]> = [
    ['noEmail', answer.drivers.no_email],
    ['ambiguous', answer.drivers.ambiguous],
    ['inactive', answer.drivers.inactive],
    ['noDriver', answer.drivers.no_driver],
    ['claimed', answer.drivers.already_claimed],
  ];
  const skipText = skips
    .filter(([, n]) => n > 0)
    .map(([key, n]) => t(SKIP_KEYS[key], { count: n }))
    .join(', ');

  const driverLine = (state: ChannelState) => {
    if (state.kind === 'off') return t('settings.abrSchedule.preview.drivers.off');
    if (state.kind === 'no_one') return t('settings.abrSchedule.preview.drivers.noOne');
    return tPlural({
      one: 'settings.abrSchedule.preview.drivers.goesOne',
      other: 'settings.abrSchedule.preview.drivers.goesOther',
    }, state.count);
  };
  const managerLine = (state: ChannelState) => {
    if (state.kind === 'off') return t('settings.abrSchedule.preview.manager.off');
    if (state.kind === 'no_one') {
      return answer.manager_claimed && answer.manager_recipients > 0
        ? t('settings.abrSchedule.preview.manager.claimed')
        : t('settings.abrSchedule.preview.manager.noOne');
    }
    if (answer.manager_via_list) return t('settings.abrSchedule.preview.manager.goesList', { count: state.count });
    if (answer.manager_via_address) return t('settings.abrSchedule.preview.manager.goesAddress');
    return tPlural({
      one: 'settings.abrSchedule.preview.manager.goesOne',
      other: 'settings.abrSchedule.preview.manager.goesOther',
    }, state.count);
  };

  return (
    <>
      <p>
        {t('settings.abrSchedule.preview.next', {
          weekday: t(WEEKDAY_KEYS[next.weekday]),
          date: germanDay(next.day),
          time: next.time,
        })}
      </p>
      {reminder && (
        <p>
          {t('settings.abrSchedule.preview.nextReminder', {
            weekday: t(WEEKDAY_KEYS[reminder.weekday]),
            date: germanDay(reminder.day),
            time: reminder.time,
          })}
        </p>
      )}
      <p>{t('settings.abrSchedule.preview.week', { range: next.weekRange })}</p>
      {verdict.noBookings ? (
        <p className="font-medium">{t('settings.abrSchedule.preview.noBookings')}</p>
      ) : (
        <>
          <p>{driverLine(verdict.drivers)}</p>
          {saved.driverMail && skipText && (
            <p className="text-fg-subtle">{t('settings.abrSchedule.preview.skipped', { list: skipText })}</p>
          )}
          <p>{managerLine(verdict.manager)}</p>
          {verdict.nothingGoes && <p className="font-medium">{t('settings.abrSchedule.preview.nothing')}</p>}
        </>
      )}
    </>
  );
};

export default AbrechnungScheduleCard;
