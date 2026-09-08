/*
  # Fix SECURITY DEFINER Function Execute Grants

  ## Problem
  Multiple SECURITY DEFINER functions are executable by the `anon` role (and some by
  `authenticated`), making them callable unauthenticated via `/rest/v1/rpc/`. This
  is a significant security risk because SECURITY DEFINER functions run with elevated
  (owner) privileges, bypassing RLS.

  ## Fix Strategy per function

  ### Revoke from BOTH anon AND authenticated (trigger/internal-only functions)
  These are trigger functions or internal helpers never meant to be called via RPC:
  - create_user_profile()         — trigger, fires on auth.users INSERT
  - handle_new_user()             — trigger, fires on auth.users INSERT
  - create_user_profile_manual()  — called only from edge functions/support tooling
  - create_user_account()         — called only from edge functions; has own email guard

  ### Revoke from anon only, keep authenticated (RLS helper / authenticated-user functions)
  These are called either from RLS policies (evaluated server-side for auth'd users)
  or from authenticated frontend RPC calls:
  - uid()                         — wrapper for auth.uid(); anon always gets NULL anyway
  - get_current_user_role()       — requires auth context to be meaningful
  - get_user_company_id()         — requires auth context (auth.uid())
  - get_user_status()             — status lookup; only meaningful for auth'd callers
  - is_role()                     — RLS helper using auth.uid()
  - is_support_user()             — RLS helper using auth.uid()
  - is_user_active()              — RLS / status helper
  - is_user_super_admin()         — RLS helper using auth.uid()
  - list_users_for_admin()        — has its own auth.email() guard; only auth'd callers
  - get_weekly_abrechnung()       — called from frontend (authenticated users only)
  - get_monthly_abrechnung()      — called from frontend (authenticated users only)
  - get_driver_weekly_abrechnung() — called from frontend (authenticated users only)
  - get_driver_monthly_abrechnung() — called from frontend (authenticated users only)
  - get_current_cash_balance()    — requires auth'd context to be meaningful

  ## Notes
  - REVOKE removes the ability to call via REST API `/rpc/` endpoint
  - Internal trigger calls are not affected by EXECUTE grants
  - RLS policy calls run as the function owner (SECURITY DEFINER), unaffected by grants
*/

-- ── Revoke from BOTH anon AND authenticated ─────────────────────────────────

-- Trigger function — only fires via INSERT on auth.users, never via RPC
REVOKE EXECUTE ON FUNCTION public.create_user_profile()
  FROM anon, authenticated;

-- Trigger function — only fires via INSERT on auth.users, never via RPC
REVOKE EXECUTE ON FUNCTION public.handle_new_user()
  FROM anon, authenticated;

-- Called only from edge functions / support tooling
REVOKE EXECUTE ON FUNCTION public.create_user_profile_manual(uuid, text, text)
  FROM anon, authenticated;

-- Called only from edge functions; has its own auth.email() guard internally
REVOKE EXECUTE ON FUNCTION public.create_user_account(text, text, text, text)
  FROM anon, authenticated;

-- ── Revoke from anon only ────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.uid()
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.get_current_user_role()
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.get_user_company_id()
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.get_user_status(uuid)
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.is_role(text)
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.is_support_user()
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.is_user_active(uuid)
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.is_user_super_admin()
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.list_users_for_admin()
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.get_weekly_abrechnung(integer, integer)
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.get_monthly_abrechnung(integer, integer)
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.get_driver_weekly_abrechnung(text, integer, integer)
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.get_driver_monthly_abrechnung(text, integer, integer)
  FROM anon;

REVOKE EXECUTE ON FUNCTION public.get_current_cash_balance(text)
  FROM anon;
