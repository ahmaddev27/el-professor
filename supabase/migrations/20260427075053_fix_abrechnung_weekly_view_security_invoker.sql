/*
  # Fix Security Definer View: abrechnung_weekly

  ## Problem
  The view `public.abrechnung_weekly` has SECURITY DEFINER behavior (default when
  created by a superuser/owner), meaning it executes with the owner's privileges
  rather than the querying user's privileges. This bypasses RLS on the underlying
  receipts and income tables.

  ## Fix
  Use ALTER VIEW to set security_invoker = true. This ensures the view executes
  with the caller's privileges and respects RLS policies on the base tables.

  Note: The SECURITY DEFINER functions (get_weekly_abrechnung, get_monthly_abrechnung,
  get_driver_weekly_abrechnung, get_driver_monthly_abrechnung) that query this view
  are themselves the access control boundary — they run as owner and are the intended
  callers of this view.
*/

ALTER VIEW public.abrechnung_weekly SET (security_invoker = true);
