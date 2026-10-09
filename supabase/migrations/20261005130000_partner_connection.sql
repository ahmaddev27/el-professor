/*
  # Connect: a company links its own Reidey fleet, and we pull

  The owner reversed the direction on 05.10.2026 and this follows it. We are not
  a push target the partner writes into; we are a client the company points at
  its own fleet. The operator clicks **Connect Reidey**, pastes a token Reidey's
  dashboard issued them, and El-Professor pulls the roster and later the
  earnings. Only a receipt travels the other way, because the driver photographs
  it inside the partner's app and we never learn it happened.

  `20261005120000` already holds the secret (`app_private.partner_credentials`,
  HMAC-SHA256 with `OTP_PEPPER`, the database never sees the key) and the driver
  link. What was missing is the **connection** itself: which company connected
  which fleet, when, by whom, and whether the pull still works.

  ## Why Connect asks which company, measured rather than assumed

  The design keys on "the company registers in both products with the same
  address". Measured on production 05.10.2026: of 18 companies, **15 have an
  active admin profile and 15 distinct addresses** — so the premise holds. But
  **two addresses each own two companies**, and one of them is
  `ahmedkhhemaid@gmail.com`, which is the very fleet this integration starts
  with.

  So an address identifies a **person**, not a company. One owner holds several
  fleets, here and there. Connect therefore never infers the company: it is
  always the company the caller is already in, and `connected_by` records who
  decided. The address is only ever a hint in the panel.

  (The first measurement I took was `companies.email` — 2 of 18 — and nearly
  reported the design unworkable. That is a contact field almost nobody fills.
  The registration address is on `user_profiles`. Measure the column that
  carries the fact, not the one whose name matches the sentence.)

  ## The state a connection can be in

    pending   a token is stored, nothing has been pulled yet
    active    the last pull succeeded
    failed    the last pull was refused or unreachable -- the panel says so
              rather than showing figures from an older pull as if current
    revoked   the operator disconnected, or the partner revoked the token

  **`failed` is a state and not a silence.** An integration that stops working
  and keeps showing its last answer is the defect this whole product keeps
  writing down: a figure whose load failed is not shown, because an empty list
  and a stale number are both claims.
*/

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The connection
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.partner_connections (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  partner             text        NOT NULL CHECK (partner = lower(btrim(partner)) AND partner <> ''),
  -- The partner's own id for the fleet this connection reaches, as the partner
  -- reported it when the token was first verified. Never taken from a form:
  -- a company typing another fleet's id would be asserting someone else's data.
  external_company_id text        NULL,
  external_company_name text      NULL,
  status              text        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','active','failed','revoked')),
  -- Why the last pull failed, as a stable code. Never a message from the
  -- partner's API: that text is theirs and may name hosts or internals.
  last_error          text        NULL,
  last_pull_at        timestamptz NULL,
  last_success_at     timestamptz NULL,
  connected_by        uuid        NULL,
  connected_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at          timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- A revoked connection names when, and a live one does not.
  CONSTRAINT partner_connections_revoked_has_time
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

-- One live connection per company per partner. A reconnect revokes the old row
-- rather than replacing it, so the history of who connected what stays.
CREATE UNIQUE INDEX IF NOT EXISTS partner_connections_live_per_company
  ON public.partner_connections (company_id, partner)
  WHERE status <> 'revoked';

COMMENT ON TABLE public.partner_connections IS
  'A company''s link to its own fleet at a partner. The company is always the '
  'caller''s own -- never inferred from an e-mail, because one address owns '
  'several companies (measured, 05.10.2026).';

ALTER TABLE public.partner_connections ENABLE ROW LEVEL SECURITY;

-- The tenant shape of 20260917130000. Connecting an integration is an
-- administrator's act, not a page right: it hands a third party this company's
-- driver data, which is the same weight as the four tables that ask for an
-- administrator rather than a page.
DROP POLICY IF EXISTS partner_connections_select ON public.partner_connections;
CREATE POLICY partner_connections_select ON public.partner_connections
  FOR SELECT TO authenticated
  USING (company_id = (SELECT public.get_active_company_id())
         OR (SELECT public.platform_reads_company_data()));

DROP POLICY IF EXISTS partner_connections_update ON public.partner_connections;
CREATE POLICY partner_connections_update ON public.partner_connections
  FOR UPDATE TO authenticated
  USING (company_id = (SELECT public.get_active_company_id())
         AND (SELECT public.is_company_admin()))
  WITH CHECK (company_id = (SELECT public.get_active_company_id())
         AND (SELECT public.is_company_admin()));

-- No INSERT policy: a connection is created by the edge function that verified
-- the token actually works. A row a client could insert would claim a working
-- connection that had never been proven.
-- No DELETE policy: disconnecting sets `revoked`, so who connected what stays.

DROP TRIGGER IF EXISTS refuse_read_only_context_write ON public.partner_connections;
CREATE TRIGGER refuse_read_only_context_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.partner_connections
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.refuse_read_only_context_write();

DROP TRIGGER IF EXISTS record_support_write ON public.partner_connections;
CREATE TRIGGER record_support_write
  AFTER INSERT OR UPDATE OR DELETE ON public.partner_connections
  FOR EACH ROW
  WHEN (current_setting('app_private.support_write_context', true) <> '')
  EXECUTE FUNCTION app_private.record_support_write();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Recording a connection, once its token has been proven to work
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.partner_connection_record(
  p_company_id            uuid,
  p_partner               text,
  p_key_hash              text,
  p_external_company_id   text    DEFAULT NULL,
  p_external_company_name text    DEFAULT NULL,
  p_connected_by          uuid    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_partner text := lower(btrim(coalesce(p_partner, '')));
  v_id      uuid;
BEGIN
  IF p_company_id IS NULL OR v_partner = '' OR p_key_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid argument'
      USING ERRCODE = '22023', HINT = 'invalid_request';
  END IF;

  -- Reconnecting revokes what was there rather than overwriting it: the row
  -- records a decision a person made, and the next decision is a new row.
  UPDATE public.partner_connections
     SET status = 'revoked', revoked_at = now(), updated_at = now()
   WHERE company_id = p_company_id AND partner = v_partner AND status <> 'revoked';

  UPDATE app_private.partner_credentials
     SET disabled_at = now()
   WHERE company_id = p_company_id AND partner = v_partner AND disabled_at IS NULL;

  INSERT INTO app_private.partner_credentials
         (company_id, partner, key_hash, external_company_id, created_by)
  VALUES (p_company_id, v_partner, p_key_hash, p_external_company_id, p_connected_by);

  INSERT INTO public.partner_connections
         (company_id, partner, external_company_id, external_company_name,
          status, connected_by, last_success_at)
  VALUES (p_company_id, v_partner, p_external_company_id, p_external_company_name,
          'active', p_connected_by, now())
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'connection_id', v_id);
END;
$$;

COMMENT ON FUNCTION public.partner_connection_record(uuid, text, text, text, text, uuid) IS
  'Stores a partner connection and its hashed token, after the edge function has '
  'proven the token works. Revokes any previous one rather than overwriting it. '
  'Service role only.';

REVOKE ALL ON FUNCTION public.partner_connection_record(uuid, text, text, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.partner_connection_record(uuid, text, text, text, text, uuid)
  TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Self-check
-- ─────────────────────────────────────────────────────────────────────────────

DO $check$
DECLARE
  r record;
  n int;
BEGIN
  -- 1. no INSERT and no DELETE policy. One would let a client claim a working
  --    connection that was never proven, or erase who connected what.
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'partner_connections'
     AND cmd IN ('INSERT', 'DELETE');
  IF n > 0 THEN
    RAISE EXCEPTION 'self-check 1: partner_connections gained an INSERT or DELETE policy';
  END IF;

  -- 2. the write policy asks for an administrator, not a page right: connecting
  --    hands a third party this company's driver data.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'partner_connections'
       AND cmd = 'UPDATE' AND qual LIKE '%is_company_admin%'
  ) THEN
    RAISE EXCEPTION 'self-check 2: the update policy no longer asks is_company_admin()';
  END IF;

  -- 3. both context triggers (the rule of 20260924100000)
  FOR r IN SELECT unnest(ARRAY['refuse_read_only_context_write','record_support_write']) AS t LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
       WHERE c.relname = 'partner_connections' AND g.tgname = r.t AND NOT g.tgisinternal
    ) THEN
      RAISE EXCEPTION 'self-check 3: partner_connections is missing trigger %', r.t;
    END IF;
  END LOOP;

  -- 4. the recorder is not reachable from a browser
  FOR r IN SELECT unnest(ARRAY['anon','authenticated']) AS role LOOP
    IF has_function_privilege(r.role,
         'public.partner_connection_record(uuid,text,text,text,text,uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION 'self-check 4: % may execute partner_connection_record', r.role;
    END IF;
  END LOOP;

  -- 5. only one live connection per company per partner
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'partner_connections_live_per_company'
       AND indexdef LIKE 'CREATE UNIQUE INDEX%'
  ) THEN
    RAISE EXCEPTION 'self-check 5: the live-connection uniqueness index is missing';
  END IF;

  RAISE NOTICE 'partner connection: self-checks passed';
END
$check$;
