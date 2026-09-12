/*
  # Drop increment_discount_used_count

  ## Why it goes

  It existed for exactly one caller: the `apply-discount-code` edge function,
  which is deleted in the same commit. That function took `company_id`,
  `discount_amount` and `final_price` straight from the request body while
  holding the service-role key, so any authenticated user could record a
  redemption for any company at any price they typed. Nothing in `src/` ever
  called it — the browser calls `validate-discount-code`, and the commit is done
  by `company-signup`, which since 20260911120000 goes through
  `redeem_discount_code`.

  `redeem_discount_code` increments `used_count` itself, inside the same
  transaction as the `SELECT … FOR UPDATE` that read it. This function could
  only ever increment it in a *separate* statement from whoever checked the
  limit, which is the race the new RPC exists to close. Leaving it in place
  would leave a granted, service-role-executable way back around that lock.

  ## Safety

  Dropped without CASCADE on purpose: if any object still depends on it the drop
  fails loudly rather than quietly taking that object with it. Both known
  definitions are covered — 20260531113502 created it and 20260607124839
  replaced it, and `CREATE OR REPLACE` keeps one object with one signature.
*/

DROP FUNCTION IF EXISTS public.increment_discount_used_count(uuid);
