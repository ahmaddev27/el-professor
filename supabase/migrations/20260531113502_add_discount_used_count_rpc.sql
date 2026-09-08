/*
  # Add increment_discount_used_count RPC

  Helper function called by the apply-discount-code edge function (via service role)
  to atomically increment the used_count on a discount code after successful redemption.
*/

CREATE OR REPLACE FUNCTION increment_discount_used_count(code_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE discount_codes
  SET used_count = used_count + 1
  WHERE id = code_id;
END;
$$;

-- Only service role / superadmins should call this — revoke from public
REVOKE EXECUTE ON FUNCTION increment_discount_used_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION increment_discount_used_count(uuid) TO service_role;
