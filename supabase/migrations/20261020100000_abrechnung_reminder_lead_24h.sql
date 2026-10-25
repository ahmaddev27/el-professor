/*
  The weekly Abrechnung reminder may be sent up to 24 hours before the driver
  mail (it was 12), so "the evening before" is expressible: a Monday 10:00 send
  with a 14-hour lead reminds on Sunday 20:00.

  abrechnung_schedules_reminder_lead_check carried 15 to 720, the same range as
  REMINDER_LEAD_MIN_MINUTES / REMINDER_LEAD_MAX_MINUTES in
  supabase/functions/_shared/abrechnung-schedule-core.ts. Both move together to
  15 to 1440. 1440 is the ceiling and not more because dueReminder looks at
  today and tomorrow as the driver mail's day, which finds a reminder moment
  that lies on the mail's day or the one before; a larger lead could put it two
  days earlier, where nothing looks.

  Widening a CHECK is backward compatible: every stored row still satisfies it
  and the previous release, which refuses a lead over 720 on its own, simply
  sends no reminder for such a row. So no SCHEMA_EPOCH bump.
*/

ALTER TABLE public.abrechnung_schedules
  DROP CONSTRAINT IF EXISTS abrechnung_schedules_reminder_lead_check;
ALTER TABLE public.abrechnung_schedules
  ADD CONSTRAINT abrechnung_schedules_reminder_lead_check
  CHECK (reminder_lead_minutes BETWEEN 15 AND 1440);

COMMENT ON COLUMN public.abrechnung_schedules.reminder_enabled IS
  'Remind a driver who recorded no cash and no cash receipt, reminder_lead_minutes before the driver mail goes out (the revenue term was dropped 20.10.2026). Needs driver_mail_enabled (20261015100000).';

DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conrelid = 'public.abrechnung_schedules'::regclass
     AND conname = 'abrechnung_schedules_reminder_lead_check';
  IF v_def IS NULL OR v_def !~ '15' OR v_def !~ '1440' OR v_def ~ '720' THEN
    RAISE EXCEPTION 'reminder lead check is not 15 to 1440: %', v_def;
  END IF;
END
$$;
