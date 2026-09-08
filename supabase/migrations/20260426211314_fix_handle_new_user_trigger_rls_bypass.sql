/*
  # Fix handle_new_user trigger — RLS bypass for profile creation

  ## Problem
  The trigger `handle_new_user` fires when Supabase Auth creates a new user via
  `auth.admin.createUser()`. At that moment `auth.uid()` is NULL (service-role
  context), so the INSERT RLS policy `WITH CHECK (user_id = auth.uid())` evaluates
  to FALSE and blocks the insert. Supabase Auth then surfaces this as
  "Database error creating new user".

  ## Fix
  1. Rewrite `handle_new_user` to use `SET LOCAL row_security = off` so the
     trigger's own INSERT bypasses RLS entirely (safe: the function is
     SECURITY DEFINER owned by postgres and only runs on auth.users INSERT).
  2. Also make `role` default to 'viewer' robustly and keep all existing columns.
  3. The edge function handles company_id / role_id assignment immediately after
     via the service-role client which also bypasses RLS — no change needed there.

  ## Security
  - The function remains SECURITY DEFINER / owned by postgres.
  - `row_security = off` is scoped to the current transaction (SET LOCAL) so it
    does not affect any other query outside the trigger call.
  - The INSERT policy on user_profiles continues to protect all other callers.
*/

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Disable RLS for this trigger's own INSERT only.
  -- auth.uid() is NULL in the admin.createUser context so the normal
  -- INSERT policy (user_id = auth.uid()) would block this row.
  SET LOCAL row_security = off;

  INSERT INTO user_profiles (user_id, email, full_name, role, status, invited_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'role', 'viewer'),
    CASE
      WHEN NEW.email_confirmed_at IS NULL THEN 'pending_invite'
      ELSE 'active'
    END,
    CASE
      WHEN NEW.email_confirmed_at IS NULL THEN NOW()
      ELSE NULL
    END
  )
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;
