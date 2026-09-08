ALTER TABLE driver_notes
  ADD COLUMN IF NOT EXISTS note_type             text    NOT NULL DEFAULT 'general',
  ADD COLUMN IF NOT EXISTS note_planning_behavior text    NOT NULL DEFAULT 'neutral'
    CHECK (note_planning_behavior IN ('neutral', 'exclude_from_plan', 'must_include_in_plan')),
  ADD COLUMN IF NOT EXISTS is_full_day           boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS start_time            text    NULL,
  ADD COLUMN IF NOT EXISTS end_time              text    NULL;
