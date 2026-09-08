/*
  # Stop handle_new_user from trusting client-supplied role metadata

  ## Problem

  `handle_new_user` fires on every INSERT into auth.users and wrote the new
  profile's role straight from `raw_user_meta_data`:

      COALESCE(NEW.raw_user_meta_data->>'role', 'viewer')

  `raw_user_meta_data` is whatever the client passed to `signUp({ options: { data } })`.
  The anon key is public, so anyone can self-register with `{"role":"admin"}` and
  receive a profile with `role = 'admin'`.

  The `user_profiles` privilege guard does not stop this. It bypasses itself when
  `auth.uid()` IS NULL (20260430082323, lines 57-60), and `auth.uid()` is always
  NULL inside this trigger because the row is created by the auth service, not by
  an authenticated session.

  This chains with the `manage-users` edge function, whose only authorization gate
  is `role !== 'admin' && !is_super_admin`. A self-registered "admin" carries
  company_id = NULL, which that function treats as "no tenant restriction" — so the
  chain ends in cross-tenant user enumeration and password resets.

  ## Fix

  New profiles are always created as 'viewer' with no company. Role assignment is
  the job of the flows that already do it correctly, immediately after creating the
  auth user, through the service-role client:

    - manage-users /create upserts role, role_id and company_id (index.ts:191-203)
    - company-signup assigns the owner's admin role after creating the company

  Neither depends on the trigger reading role metadata, so nothing legitimate
  changes. `full_name` is still taken from metadata — it carries no privilege.

  ## Security

  - Removes the only path by which an unauthenticated caller can influence a
    privilege column.
  - The function stays SECURITY DEFINER with a pinned search_path.
  - `SET LOCAL row_security = off` is retained: it is required because auth.uid()
    is NULL here and the INSERT policy would otherwise reject the row. It is scoped
    to this transaction.
*/

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Disable RLS for this trigger's own INSERT only. auth.uid() is NULL in the
  -- auth-service context, so the normal INSERT policy (user_id = auth.uid())
  -- would block this row.
  SET LOCAL row_security = off;

  INSERT INTO user_profiles (user_id, email, full_name, role, status, invited_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    -- Never derived from client-controlled metadata. Privileged flows assign the
    -- real role immediately afterwards via the service-role client.
    'viewer',
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

/*
  Remediate any account that already self-assigned a privileged role through the
  old trigger. A profile that holds a privileged role while belonging to no
  company was never created by a legitimate flow: manage-users /create always
  writes a company_id, and company-signup always attaches the owner to the
  company it just created.

  Super admins are excluded — they legitimately have no company_id.
*/
UPDATE public.user_profiles
SET    role = 'viewer'
WHERE  company_id IS NULL
  AND  COALESCE(is_super_admin, false) = false
  AND  role IS DISTINCT FROM 'viewer';
